// The microphone side: speech recognition (or the ?sim script), turning what
// was heard into transcript lines, and deciding when to ask the model.

import { ask, cancelAll, isAnswering } from "./answering";
import { keepWarm } from "./connection";
import { looksAimedAt, wordCount } from "./conversation";
import { EarlyFire } from "./early";
import { keepScreenOn, releaseScreen } from "./screen";
import { SimStt, simLog } from "./sim";
import { SIM, everyLine, rememberMeeting, settings, state, underFreeLimit } from "./state";
import { Stt, sttSupported, type SttCallbacks } from "./stt";
import { els, environment, setMeta, setStatus, showAnswer } from "./ui";
import { renderLines, updateContext } from "./view";

const MIN_WORDS = 3; // "okay", "yeah", "mhm": not worth a call
const LIVE_CHARS = 80; // about 2 lines of the live line at 375 px

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
    rememberMeeting();
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
    rememberMeeting();
    if (SIM) simLog.push({ at: Date.now(), kind: "final-after-early", text: finalText, ms: gainedMs });
    if (reask && underFreeLimit()) void ask(false, index);
    else if (!isAnswering()) setMeta(`${els.meta.textContent} · ${gainedMs} ms early`);
  },
});

const callbacks: SttCallbacks = {
  onInterim: (text) => {
    // A long sentence stays one live result until the pause: show its newest words.
    els.interim.textContent = text.length > LIVE_CHARS ? `…${text.slice(-LIVE_CHARS)}` : text;
    early.interim(text);
  },
  onFinal: (u) => {
    els.interim.textContent = "";
    if (early.final(u.text, u.at)) return;
    state.transcript.push(u);
    state.session.push({ at: u.at, kind: "heard", text: u.text });
    renderLines();
    updateContext();
    rememberMeeting();
    if (!settings.auto || wordCount(u.text) < MIN_WORDS) return;
    if (everyLine()) {
      void ask(false);
    } else if (aimed(u.text)) {
      if (underFreeLimit()) void ask(false);
      else setMeta("rate limit: tap a line or Answer");
    }
  },
  onStatus: (text) => {
    setStatus(text);
    if (text.startsWith("Mic error") || text.startsWith("Speech service") || text.startsWith("Could not start")) {
      setMeta(environment());
    }
    // The header is one line; long instructions go where they can be read.
    if (text.startsWith("Speech service") || text.startsWith("Could not start")) showAnswer(text, true);
  },
  onGaveUp: () => stopped(),
};

export const stt: Stt | SimStt = SIM ? new SimStt(callbacks) : new Stt(callbacks, settings.lang);

// main.ts shows the "Update ready" pill only while not listening.
export const LISTENING_CHANGED = "live-board:listening";

function stopped(): void {
  early.reset();
  els.interim.textContent = "";
  keepWarm(false);
  releaseScreen();
  els.listen.textContent = "Start";
  els.listen.classList.remove("live");
  window.dispatchEvent(new Event(LISTENING_CHANGED));
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
  if (!settings.apiKey || !state.board) {
    // Still listen (the transcript is useful on its own), but say what's missing now, not mid-meeting.
    showAnswer(!settings.apiKey ? "Listening, but no API key yet: add one in settings (⚙︎) to get answers." : "Listening, but no board loaded: pick one in settings (⚙︎).", true);
  }
  stt.start();
  keepWarm(true);
  void keepScreenOn();
  els.listen.textContent = "Stop";
  els.listen.classList.add("live");
  window.dispatchEvent(new Event(LISTENING_CHANGED));
}

// "New meeting": forget the pending early line and any call in flight.
export function resetListening(): void {
  early.reset();
  cancelAll();
}
