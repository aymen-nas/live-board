// One call to the model: the transcript window ending at a line, streamed
// onto the screen. A newer call cancels the one in flight.

import { windowEndingAt } from "./conversation";
import { answer } from "./llm";
import { simLog } from "./sim";
import { SIM, limiter, settings, state } from "./state";
import { els, flash, setMeta, showAnswer } from "./ui";
import { renderChips, renderHistory, renderRate } from "./view";

let inflight: AbortController | null = null;

export function cancelAnswer(): void {
  inflight?.abort();
  inflight = null;
  els.answer.classList.remove("thinking");
}

export async function ask(forced: boolean, upto = state.transcript.length - 1): Promise<void> {
  if (!settings.apiKey) {
    showAnswer("Add your API key in settings.", true);
    return;
  }
  if (!state.systemPrompt) {
    showAnswer("Paste a board in settings first.", true);
    return;
  }
  const window_ = windowEndingAt(state.transcript, upto);
  if (window_.length === 0) {
    showAnswer("Nothing heard yet.", true);
    return;
  }

  // Latest wins: a newer request cancels the answer in flight.
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  const askedAt = forced ? Date.now() : window_[window_.length - 1]!.at;
  els.answer.classList.add("thinking");
  limiter.record();
  renderRate();

  let streaming = false;
  try {
    const result = await answer({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: state.systemPrompt,
      transcript: window_,
      forced,
      signal: controller.signal,
      onFirstToken: () => setMeta(`${Date.now() - askedAt} ms`),
      onDelta: (text) => {
        if (!streaming) {
          streaming = true;
          flash();
        }
        showAnswer(text);
      },
    });
    if (controller.signal.aborted) return;
    const now = Date.now();
    if (result.silent && forced) {
      // I asked and got nothing: say so, or the tap looks ignored.
      showAnswer("Nothing to say on that line.", true);
      flash();
    } else if (result.silent) {
      // Nothing for me: put the previous answer back if streaming had started.
      const last = state.answers[state.answers.length - 1];
      if (last) showAnswer(last.text);
      els.answer.classList.add("muted");
    } else {
      showAnswer(result.text);
      state.answers.push({ at: now, text: result.text });
      state.session.push({ at: now, kind: "answer", text: result.text });
      state.lastAnswerAt = now;
      renderHistory();
      renderChips(null);
    }
    if (SIM) simLog.push({ at: now, kind: result.silent ? "silent" : "answer", text: result.text, ms: now - askedAt });
    if (settings.provider === "anthropic") {
      const cache = result.cacheRead > 0 ? "cached" : result.cacheWrite > 0 ? "cache written" : "no cache";
      setMeta(`${els.meta.textContent} · ${cache}`);
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    const msg = err instanceof Error ? err.message : String(err);
    showAnswer(/429/.test(msg) ? "Rate limit reached; wait a few seconds." : `Error: ${msg}`, true);
    if (SIM) simLog.push({ at: Date.now(), kind: "error", text: msg });
  } finally {
    if (inflight === controller) {
      inflight = null;
      els.answer.classList.remove("thinking");
    }
  }
}
