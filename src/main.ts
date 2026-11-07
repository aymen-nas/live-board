// Live Board: wiring and start-up. The pieces:
//   ui.ts           markup, element handles, display helpers (mounts the app)
//   state.ts        settings and meeting state
//   view.ts         renders lines, history, chips, counter; loads the board
//   listening.ts    speech recognition -> transcript -> when to ask
//   early.ts        answer before the engine finalizes a sentence
//   answering.ts    one streamed call to the model
//   connection.ts   preconnect and keep-warm
//   settingsDialog  boards (GitHub, saved, pasted) and provider settings
//   update.ts       "Update ready" when a new version is deployed

import "./style.css";
import { els, setMeta, setStatus, showAnswer, showCard, environment } from "./ui";
import { ask } from "./answering";
import { preconnect } from "./connection";
import { toggleListening } from "./listening";
import { saveSettings } from "./settings";
import { initSettings, syncRemote } from "./settingsDialog";
import { exportSession } from "./session";
import { devKey, loadSimBoard } from "./sim";
import { PROVIDERS } from "./llm";
import { SIM, settings, state } from "./state";
import { sttSupported } from "./stt";
import { setupUpdates } from "./update";
import { initChips, loadBoard, renderRate, showQuestion } from "./view";

els.listen.addEventListener("click", toggleListening);
els.answerBtn.addEventListener("click", () => void ask(true));

// Tap a transcript line to get the answer to exactly that line.
els.lines.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>(".line");
  const i = Number(target?.dataset.i);
  if (target && Number.isInteger(i)) void ask(true, i);
});

els.nudge.addEventListener("click", () => {
  const questions = state.board?.questions ?? [];
  if (questions.length === 0) {
    showAnswer("No question bank in this board.", true);
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
  saveSettings(settings);
});

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
  els.update.hidden = false;
  els.update.onclick = reload;
});
if (state.board) showAnswer(`${settings.boardName || "Board"} loaded. Start listening.`, true);
setStatus(sttSupported() ? "Ready" : "No speech recognition in this browser");
if (!sttSupported()) setMeta(environment());
