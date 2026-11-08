// Calls to the model, streamed onto the screen.
//
// Auto calls run side by side: a later line that turns out not to be for me
// must not cancel an answer that is still streaming. A tap (forced) replaces
// everything in flight; a re-ask of the same line replaces that line's auto
// call, but never a tap. Only the newest call that has text may draw. Answers
// are kept in call order, so one that finishes late lands in the history.
// Auto calls never put an error on the answer area; they note it in the top
// line, so a failing filler line can't hide a good answer.

import { windowEndingAt } from "./conversation";
import { ProviderError, answer } from "./llm";
import { simLog } from "./sim";
import { SIM, limiter, rememberMeeting, settings, state, type Answer } from "./state";
import { announce, els, flash, setMeta, showAnswer, showError } from "./ui";
import { renderChips, renderHistory, renderRate } from "./view";

interface Call {
  seq: number;
  upto: number;
  forced: boolean;
  controller: AbortController;
}

const live = new Map<number, Call>();
let lastSeq = 0;
// The text on screen is a stream that was cut off (its call was replaced).
let partialOnScreen = false;

function renderBusy(): void {
  els.answer.classList.toggle("thinking", live.size > 0);
}

export function isAnswering(): boolean {
  return live.size > 0;
}

function abort(c: Call): void {
  if (c.seq === state.shownSeq) partialOnScreen = true;
  c.controller.abort();
  live.delete(c.seq);
}

export function cancelAll(): void {
  for (const c of [...live.values()]) abort(c);
  partialOnScreen = false;
  renderBusy();
}

// A cut-off stream is on screen and nothing else will replace it: put the
// last full answer back, dimmed.
function restoreIfPartial(): void {
  if (!partialOnScreen || live.has(state.shownSeq)) return;
  partialOnScreen = false;
  const last = state.answers[state.answers.length - 1];
  if (last) state.shownSeq = last.seq;
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
    showAnswer("Add your API key in settings (⚙︎).", true);
    return;
  }
  if (!state.systemPrompt) {
    showAnswer("Pick a board in settings (⚙︎) first.", true);
    return;
  }
  const window_ = windowEndingAt(state.transcript, upto);
  if (window_.length === 0) {
    showAnswer("Nothing heard yet.", true);
    return;
  }

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
  const mayDraw = (): boolean => call.seq >= state.shownSeq;
  let drawing = false;
  const draw = (): void => {
    if (drawing) return;
    drawing = true;
    state.shownSeq = call.seq;
    partialOnScreen = false;
    flash();
    renderHistory(); // the answer that was on screen moves to the history
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
        if (mayDraw()) setMeta(`${Date.now() - askedAt} ms`);
      },
      onDelta: (text) => {
        if (!mayDraw()) return;
        draw();
        showAnswer(text);
      },
    });
    if (call.controller.signal.aborted) return;
    const now = Date.now();
    if (result.silent) {
      restoreIfPartial();
      if (forced) {
        // I asked and got nothing: keep the last answer, dimmed, and say so.
        setMeta("Nothing to say on that line.");
        els.answer.classList.add("muted");
      } else if (live.size === 1 && state.shownSeq < call.seq) {
        // Nothing for me and nothing newer on its way: the answer on screen is old.
        els.answer.classList.add("muted");
      }
    } else {
      if (mayDraw()) {
        draw();
        showAnswer(result.text);
        announce(result.text);
      }
      fileAnswer({ at: now, text: result.text, seq: call.seq });
      state.session.push({ at: now, kind: "answer", text: result.text });
      state.lastAnswerAt = now;
      renderHistory();
      renderChips(null);
      rememberMeeting();
    }
    if (SIM) simLog.push({ at: now, kind: result.silent ? "silent" : "answer", text: result.text, ms: now - askedAt });
    if (settings.provider === "anthropic" && drawing) {
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
    restoreIfPartial();
    if (forced) {
      draw();
      showError(text);
    } else {
      setMeta(text);
    }
    if (SIM) simLog.push({ at: Date.now(), kind: "error", text: err instanceof Error ? err.message : String(err) });
  } finally {
    live.delete(call.seq);
    renderBusy();
  }
}
