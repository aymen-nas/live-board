// The microphone side: speech recognition (or the ?sim script), turning what
// was heard into transcript lines, and deciding when to ask the model.

import { ask } from "./answering";
import { keepWarm } from "./connection";
import { looksAimedAt, wordCount } from "./conversation";
import { EarlyFire } from "./early";
import { keepScreenOn, releaseScreen } from "./screen";
import { SimStt, simLog } from "./sim";
import { SIM, isFree, settings, state, underFreeLimit } from "./state";
import { Stt, sttSupported, type SttCallbacks } from "./stt";
import { els, environment, setMeta, setStatus, showAnswer } from "./ui";
import { renderLines, updateContext } from "./view";

const MIN_WORDS = 3; // "okay", "yeah", "mhm": not worth a call

const aimed = (text: string): boolean => looksAimedAt(text, settings.myName);

const early = new EarlyFire({
  wanted: (text) => settings.auto && aimed(text),
  canCall: underFreeLimit,
  fire: (text, at) => {
    state.transcript.push({ text, at });
    state.session.push({ at, kind: "heard", text });
    const index = state.transcript.length - 1;
    renderLines();
    updateContext();
    if (SIM) simLog.push({ at, kind: "early", text });
    void ask(false, index);
    return index;
  },
  settle: (index, finalText, reask, gainedMs) => {
    const line = state.transcript[index];
    if (!line) return;
    line.text = finalText;
    // The session entry for this line is the last "heard" entry with its time.
    const entry = state.session.findLast((e) => e.kind === "heard" && e.at === line.at);
    if (entry) entry.text = finalText;
    renderLines();
    updateContext();
    if (SIM) simLog.push({ at: Date.now(), kind: "final-after-early", text: finalText, ms: gainedMs });
    if (reask && underFreeLimit()) void ask(false, index);
    else if (!els.answer.classList.contains("thinking")) setMeta(`${els.meta.textContent} · ${gainedMs} ms early`);
  },
});

const callbacks: SttCallbacks = {
  onInterim: (text) => {
    els.interim.textContent = text;
    early.interim(text);
  },
  onFinal: (u) => {
    els.interim.textContent = "";
    if (early.final(u.text, u.at)) return;
    state.transcript.push(u);
    state.session.push({ at: u.at, kind: "heard", text: u.text });
    renderLines();
    updateContext();
    if (!settings.auto || wordCount(u.text) < MIN_WORDS) return;
    if (!isFree()) {
      void ask(false);
    } else if (aimed(u.text)) {
      if (underFreeLimit()) void ask(false);
      else setMeta("rate limit: tap a line or Answer");
    }
  },
  onStatus: (text) => {
    setStatus(text);
    if (text.startsWith("Mic error") || text.startsWith("Speech service")) setMeta(environment());
  },
  onGaveUp: () => stopped(),
};

export const stt: Stt | SimStt = SIM ? new SimStt(callbacks) : new Stt(callbacks, settings.lang);

function stopped(): void {
  early.reset();
  keepWarm(false);
  releaseScreen();
  els.listen.textContent = "Start";
  els.listen.classList.remove("live");
}

export function toggleListening(): void {
  if (stt.isListening()) {
    stt.stop();
    stopped();
    return;
  }
  if (!SIM && !sttSupported()) {
    showAnswer("This browser has no speech recognition. On iPhone, any browser works; on a computer, use Chrome or Safari.", true);
    return;
  }
  stt.start();
  keepWarm(true);
  void keepScreenOn();
  els.listen.textContent = "Stop";
  els.listen.classList.add("live");
}

// "New meeting": forget the pending early line along with the transcript.
export function resetListening(): void {
  early.reset();
}
