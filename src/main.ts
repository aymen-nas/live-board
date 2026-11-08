// Live Board: wiring and start-up. The pieces:
//   ui.ts           markup, element handles, display helpers (mounts the app)
//   state.ts        settings and meeting state
//   view.ts         renders lines, history, chips, counter; loads the board
//   listening.ts    speech recognition -> transcript -> when to ask
//   early.ts        answer before the engine finalizes a sentence
//   answering.ts    one streamed call to the model
//   connection.ts   preconnect and keep-warm
//   settingsDialog  boards (GitHub, saved, pasted) and provider settings
//   meeting.ts      the meeting survives a reload
//   update.ts       "Update ready" when a new version is deployed

import "./style.css";
import { els, setMeta, setStatus, showAnswer, showCard, environment } from "./ui";
import { ask } from "./answering";
import { preconnect } from "./connection";
import { LISTENING_CHANGED, newMeeting, stt, toggleListening } from "./listening";
import { loadMeeting } from "./meeting";
import { initSettings, syncRemote } from "./settingsDialog";
import { exportSession } from "./session";
import { devKey, loadSimBoard } from "./sim";
import { PROVIDERS } from "./llm";
import { SIM, flushMeeting, persistSettings, settings, state } from "./state";
import { sttSupported } from "./stt";
import { setupUpdates } from "./update";
import { initChips, loadBoard, renderHistory, renderLines, renderRate, showNotice, showQuestion } from "./view";

els.listen.addEventListener("click", toggleListening);
els.answerBtn.addEventListener("click", () => void ask(true));

// Tap a transcript line to get the answer to exactly that line. A new line
// can arrive while the finger is down and rebuild the list; iOS then drops
// the click. So the line is taken where the touch started and answered on
// finger-up; a drag (scrolling the list) is not a tap.
let touchedLine: { i: number; y: number; at: number } | null = null;
const lineIndex = (target: EventTarget | null): number | null => {
  const i = Number((target as HTMLElement | null)?.closest<HTMLElement>(".line")?.dataset.i);
  return Number.isInteger(i) ? i : null;
};
els.lines.addEventListener("pointerdown", (e) => {
  const i = lineIndex(e.target);
  touchedLine = i === null ? null : { i, y: e.clientY, at: Date.now() };
  if (i !== null) els.lines.setPointerCapture(e.pointerId);
});
// A tap that only stops a scroll fling isn't a request for an answer.
let lastScrollAt = 0;
els.lines.addEventListener(
  "scroll",
  () => {
    const l = els.lines;
    // The list scrolling itself to the newest line, or the layout clamping it
    // at the bottom, isn't a fling.
    const atBottom = l.scrollTop >= l.scrollHeight - l.clientHeight - 1;
    if (!atBottom && Date.now() - Number(l.dataset.autoscroll ?? 0) > 100) lastScrollAt = Date.now();
  },
  { passive: true },
);
els.lines.addEventListener("pointerup", (e) => {
  const t = touchedLine;
  touchedLine = null;
  // Not a tap if the list was moving when the finger landed (stopping a fling) or moved since.
  if (t && Math.abs(e.clientY - t.y) < 12 && lastScrollAt < t.at - 100) void ask(true, t.i);
});
els.lines.addEventListener("pointercancel", () => {
  touchedLine = null;
});
// Keyboard (Enter/Space on a focused line) still clicks; taps are handled above.
els.lines.addEventListener("click", (e) => {
  if (e.detail !== 0) return;
  const i = lineIndex(e.target);
  if (i !== null) void ask(true, i);
});

els.nudge.addEventListener("click", () => {
  const questions = state.board?.questions ?? [];
  if (questions.length === 0) {
    showNotice("No question bank in this board.");
    return;
  }
  showQuestion(questions[state.questionIndex % questions.length]!);
  state.questionIndex++;
});

els.copy.addEventListener("click", async () => {
  const text = exportSession(state.session, settings.boardName);
  if (!text) {
    setStatus("Nothing to copy yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${state.session.length} lines`);
  } catch {
    showCard("Transcript", text); // clipboard blocked: select it by hand
  }
});

els.auto.addEventListener("change", () => {
  settings.auto = els.auto.checked;
  persistSettings();
});

// Offline: say so right away instead of letting calls fail one by one. Back
// online, clear only our own "Offline" (not a mic error or a missing engine).
// Statuses that say something is broken stay; anything else gives way to "Offline".
const STICKY = /^(Mic error|Speech service|Could not start|No speech|Speech recognition not|Cache warm failed)/;
window.addEventListener("offline", () => {
  if (!STICKY.test(els.status.textContent ?? "")) setStatus("Offline");
});
window.addEventListener("online", () => {
  if (els.status.textContent === "Offline") setStatus(stt.isListening() ? "Listening" : "Ready");
});

// Hidden, reloaded or evicted: save the meeting now, not in a second.
window.addEventListener("pagehide", flushMeeting);
// iOS often resumes the app hours later instead of restarting it: a meeting
// whose last line is over 30 minutes old is over, so start fresh.
const STALE_MS = 30 * 60_000;
const AWAY_MS = 60_000; // a quick switch to another app is not "later"
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    flushMeeting();
    return;
  }
  const last = state.transcript[state.transcript.length - 1];
  const away = hiddenAt > 0 && Date.now() - hiddenAt > AWAY_MS;
  // While hidden the mic heard nothing; a last line this old means the meeting is over.
  if (away && last && Date.now() - last.at > STALE_MS) {
    newMeeting("New meeting. The last one ended over 30 minutes ago and was cleared.");
  }
});

// "Update ready" reloads the page, so offer it only while not listening.
let reloadForUpdate: (() => void) | null = null;
const renderUpdatePill = (): void => {
  els.update.hidden = !reloadForUpdate || stt.isListening();
};
window.addEventListener(LISTENING_CHANGED, renderUpdatePill);
els.update.addEventListener("click", () => reloadForUpdate?.());

initChips();
initSettings();

// The free-plan counter refills as calls age out of the last minute.
window.setInterval(renderRate, 5_000);

// ---------- start-up ----------

els.auto.checked = settings.auto;
if (SIM) {
  // Simulation: sample board, and in dev the key from .env.local, without
  // touching the saved settings.
  const key = devKey();
  if (key && !settings.apiKey) {
    settings.provider = "routeway";
    settings.baseUrl = PROVIDERS.routeway.baseUrl;
    settings.model = PROVIDERS.routeway.model;
    settings.apiKey = key;
  }
  settings.boardText = await loadSimBoard();
  settings.boardName = "Sample board";
}
loadBoard();
preconnect();
renderRate();
void syncRemote(true);
setupUpdates((reload) => {
  reloadForUpdate = reload;
  renderUpdatePill();
});

// Back from a reload mid-meeting: put the transcript and answers back.
const saved = SIM ? null : loadMeeting();
if (saved && saved.transcript.length) {
  state.transcript.push(...saved.transcript);
  state.session.push(...saved.session);
  // Earlier calls get negative numbers, so this session's calls (1, 2, …) are newer.
  saved.answers.forEach((a, k) => state.answers.push({ at: a.at, text: a.text, seq: k - saved.answers.length }));
  const lastSaved = state.answers[state.answers.length - 1];
  state.screen = lastSaved ? { kind: "answer", seq: lastSaved.seq } : { kind: "notice" };
  renderLines();
  renderHistory();
  const last = state.answers[state.answers.length - 1];
  showAnswer(last ? last.text : "Meeting restored. Tap Start to keep listening.", true);
  setMeta(`restored ${saved.transcript.length} lines`);
} else if (!settings.apiKey || !state.board) {
  showAnswer(
    !settings.apiKey
      ? "Welcome. Step 1: tap ⚙︎ and add your API key under Provider, key and language. Step 2: pick a board."
      : "Step 2: tap ⚙︎ and pick a board (Boards from Claude, or paste one).",
    true,
  );
} else {
  showAnswer(`${settings.boardName || "Board"} loaded. Start listening.`, true);
}
setStatus(!sttSupported() ? "No speech recognition in this browser" : navigator.onLine ? "Ready" : "Offline");
if (!sttSupported()) setMeta(environment());
