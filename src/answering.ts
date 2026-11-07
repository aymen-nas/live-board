// Calls to the model, streamed onto the screen.
//
// Auto calls run side by side: a later line that turns out not to be for me
// must not cancel an answer that is still streaming. A tap (forced) replaces
// everything in flight, and a re-ask of the same line replaces that line's
// call. Only the newest call that has text may draw on screen, so an older
// answer finishing late goes to the history instead of overwriting.

import { windowEndingAt } from "./conversation";
import { EmptyAnswerError, ProviderError, answer } from "./llm";
import { simLog } from "./sim";
import { SIM, limiter, rememberMeeting, settings, state } from "./state";
import { announce, els, flash, setMeta, showAnswer, showError } from "./ui";
import { renderChips, renderHistory, renderRate } from "./view";

interface Call {
  seq: number;
  upto: number;
  controller: AbortController;
}

const live = new Map<number, Call>();
let lastSeq = 0;
let shownSeq = 0; // the call whose text is on screen

function renderBusy(): void {
  els.answer.classList.toggle("thinking", live.size > 0);
}

export function isAnswering(): boolean {
  return live.size > 0;
}

export function cancelAll(): void {
  for (const c of live.values()) c.controller.abort();
  live.clear();
  renderBusy();
}

// What went wrong, in words for the screen.
function describe(err: unknown): { text: string; offline: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number }).status;
  if (!navigator.onLine || (err instanceof TypeError && /fetch|network|load/i.test(msg))) {
    return { text: "No connection: check the network, then tap a line or Answer.", offline: true };
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
    if (forced || c.upto === upto) {
      c.controller.abort();
      live.delete(c.seq);
    }
  }
  const call: Call = { seq: ++lastSeq, upto, controller: new AbortController() };
  live.set(call.seq, call);
  renderBusy();
  const calledAt = Date.now();
  limiter()?.record(calledAt);
  renderRate();

  const askedAt = forced ? calledAt : window_[window_.length - 1]!.at;
  const mayDraw = (): boolean => call.seq >= shownSeq;
  let drawing = false;
  const draw = (): void => {
    if (!drawing) {
      drawing = true;
      shownSeq = call.seq;
      flash();
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
    if (result.silent && forced) {
      // I asked and got nothing: say so, or the tap looks ignored.
      if (mayDraw()) {
        draw();
        showAnswer("Nothing to say on that line.", true);
      }
    } else if (result.silent) {
      // Nothing for me. If nothing newer is on its way, dim the old answer.
      if (call.seq === lastSeq && live.size === 1) els.answer.classList.add("muted");
    } else {
      const onScreen = mayDraw();
      if (onScreen) {
        draw();
        showAnswer(result.text);
        announce(result.text);
        state.answers.push({ at: now, text: result.text });
      } else {
        // A newer answer is already showing: file this one just under it.
        state.answers.splice(Math.max(0, state.answers.length - 1), 0, { at: now, text: result.text });
      }
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
    if (err instanceof EmptyAnswerError && !forced) {
      setMeta(text); // an auto call that came back empty: note it, keep the screen
    } else if (forced || mayDraw()) {
      draw();
      showError(text);
    }
    if (SIM) simLog.push({ at: Date.now(), kind: "error", text: err instanceof Error ? err.message : String(err) });
  } finally {
    live.delete(call.seq);
    renderBusy();
  }
}
