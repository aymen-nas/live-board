// Calls to the model, streamed onto the screen.
//
// Auto calls run side by side: a later line that turns out not to be for me
// must not cancel an answer that is still streaming. A tap (forced) replaces
// everything in flight, and an auto re-ask of a line replaces that line's
// auto call (a line I tapped isn't re-asked at all).
//
// The screen has one owner (state.screen): a streaming call, a finished
// answer or a notice. A call may draw only if no newer call has drawn
// before (`newest` only goes up), so an older answer finishing late goes to
// the history. A stream that ends without an answer (aborted, failed) is
// replaced by the last full answer, dimmed. Auto calls never put an error
// on the answer area; they note it in the top line.

import { windowEndingAt } from "./conversation";
import { ProviderError, answer } from "./llm";
import { simLog } from "./sim";
import { SIM, limiter, rememberMeeting, settings, state, type Answer } from "./state";
import { announce, els, flash, setMeta, showAnswer, showError } from "./ui";
import { renderChips, renderHistory, renderRate, showNotice } from "./view";

interface Call {
  seq: number;
  upto: number;
  forced: boolean;
  controller: AbortController;
}

const live = new Map<number, Call>();
let lastSeq = 0;
let newest = 0; // the newest call whose text is on screen or became an answer

function renderBusy(): void {
  els.answer.classList.toggle("thinking", live.size > 0);
}

export function isAnswering(): boolean {
  return live.size > 0;
}

function abort(c: Call): void {
  c.controller.abort();
  live.delete(c.seq);
}

// New meeting: drop every call and forget who drew last.
export function cancelAll(): void {
  for (const c of [...live.values()]) abort(c);
  newest = 0;
  renderBusy();
}

// A stream on screen whose call is gone without an answer: put the last
// full answer back, dimmed. A notice or a finished answer is left alone.
function restoreIfStale(): void {
  const s = state.screen;
  if (s.kind !== "stream" || live.has(s.seq)) return;
  const last = state.answers[state.answers.length - 1];
  state.screen = last ? { kind: "answer", seq: last.seq } : { kind: "notice" };
  newest = last?.seq ?? 0; // the cut-off call no longer counts; older answers may draw
  showAnswer(last?.text ?? "", true);
  renderHistory();
}

function fileAnswer(a: Answer): void {
  const i = state.answers.findIndex((x) => x.seq > a.seq);
  if (i === -1) state.answers.push(a);
  else state.answers.splice(i, 0, a);
}

// What went wrong, in words for the screen.
function describe(err: unknown): { text: string; offline: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number }).status;
  if (!navigator.onLine) return { text: "No connection: check the network, then tap a line or Answer.", offline: true };
  if (err instanceof TypeError && /fetch|network|load/i.test(msg)) {
    // Safari says "Load failed" for a dropped connection and for a provider that blocks browser calls alike.
    return { text: `Network error (no connection, or the provider blocked the call): ${msg}`, offline: false };
  }
  if (status === 429) return { text: `Rate limit: ${msg}`, offline: false };
  if (status === 401 || status === 403) return { text: `Key rejected by the provider: ${msg}`, offline: false };
  if (err instanceof ProviderError && status) return { text: `Provider error ${status}: ${msg}`, offline: false };
  return { text: `Error: ${msg}`, offline: false };
}

export async function ask(forced: boolean, upto = state.transcript.length - 1): Promise<void> {
  if (!settings.apiKey) {
    showNotice("Add your API key in settings (⚙︎).");
    return;
  }
  if (!state.systemPrompt) {
    showNotice("Pick a board in settings (⚙︎) first.");
    return;
  }
  const window_ = windowEndingAt(state.transcript, upto);
  if (window_.length === 0) {
    showNotice("Nothing heard yet.");
    return;
  }

  // An auto re-ask of a line I already tapped adds nothing: the tap answers it.
  if (!forced && [...live.values()].some((c) => c.forced && c.upto === upto)) return;
  for (const c of [...live.values()]) {
    if (forced || (c.upto === upto && !c.forced)) abort(c);
  }
  const call: Call = { seq: ++lastSeq, upto, forced, controller: new AbortController() };
  live.set(call.seq, call);
  renderBusy();
  const calledAt = Date.now();
  limiter()?.record(calledAt);
  renderRate();

  const askedAt = forced ? calledAt : window_[window_.length - 1]!.at;
  const canDraw = (): boolean => call.seq >= newest;
  const owns = (): boolean => state.screen.kind !== "notice" && state.screen.seq === call.seq;
  // Take the screen (again, if a notice took it meanwhile).
  const take = (kind: "stream" | "answer"): void => {
    const fresh = !owns();
    newest = call.seq;
    state.screen = { kind, seq: call.seq };
    if (fresh) {
      flash();
      renderHistory(); // the answer that was on screen moves to the history
    }
  };

  try {
    const result = await answer({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: state.systemPrompt,
      transcript: window_,
      forced,
      signal: call.controller.signal,
      onFirstToken: () => {
        if (canDraw()) setMeta(`${Date.now() - askedAt} ms`);
      },
      onDelta: (text) => {
        if (!canDraw()) return;
        take("stream");
        showAnswer(text);
      },
    });
    if (call.controller.signal.aborted) return;
    const now = Date.now();
    if (result.silent) {
      if (forced) {
        // I asked and got nothing. If nothing newer is showing, dim what is there and say so.
        setMeta("Nothing to say on that line.");
        if (canDraw() && state.screen.kind === "answer") els.answer.classList.add("muted");
      } else if (live.size === 1 && canDraw() && state.screen.kind === "answer") {
        // Nothing for me and nothing else on its way: the answer on screen is old.
        els.answer.classList.add("muted");
      }
    } else {
      fileAnswer({ at: now, text: result.text, seq: call.seq });
      if (canDraw()) {
        take("answer");
        showAnswer(result.text);
        announce(result.text);
      }
      state.session.push({ at: now, kind: "answer", text: result.text });
      state.lastAnswerAt = now;
      renderHistory();
      renderChips(null);
      rememberMeeting();
    }
    if (SIM) simLog.push({ at: now, kind: result.silent ? "silent" : "answer", text: result.text, ms: now - askedAt });
    if (settings.provider === "anthropic" && owns()) {
      const cache = result.cacheRead > 0 ? "cached" : result.cacheWrite > 0 ? "cache written" : "no cache";
      setMeta(`${els.meta.textContent} · ${cache}`);
    }
  } catch (err) {
    if (call.controller.signal.aborted) return;
    const { text, offline } = describe(err);
    if (offline) {
      limiter()?.unrecord(calledAt); // it never reached the provider
      renderRate();
    }
    if (forced && canDraw()) {
      newest = call.seq;
      state.screen = { kind: "notice" };
      showError(text);
      renderHistory();
    } else {
      setMeta(text);
    }
    if (SIM) simLog.push({ at: Date.now(), kind: "error", text: err instanceof Error ? err.message : String(err) });
  } finally {
    live.delete(call.seq);
    restoreIfStale();
    renderBusy();
  }
}
