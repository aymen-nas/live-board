import "./style.css";
import { buildSystemPrompt, parseBoard, type Board } from "./board";
import { PROVIDERS, answer, warmCache, type Provider } from "./llm";
import { Stt, sttSupported, type Utterance } from "./stt";

// ---------- persisted settings ----------

interface Settings {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  myName: string;
  model: string;
  lang: string;
  boardText: string;
  auto: boolean;
}

const DEFAULTS: Settings = {
  provider: "anthropic",
  baseUrl: "",
  apiKey: "",
  myName: "Aymen",
  model: PROVIDERS.anthropic.model,
  lang: "en-US",
  boardText: "",
  auto: true,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("live-board.settings");
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem("live-board.settings", JSON.stringify(s));
  } catch {
    // private mode or storage blocked: the session still works, just not persisted
  }
}

// ---------- state ----------

const settings = loadSettings();
let board: Board | null = null;
let systemPrompt = "";
const transcript: Utterance[] = [];
let inflight: AbortController | null = null;
let questionIndex = 0;
let wakeLock: any = null;

const WINDOW_MS = 90_000;
const MAX_LINES = 14;
const FREE_CALLS_PER_MINUTE = 5; // Routeway's free plan; Gemini's free tier is higher
const callTimes: number[] = [];

// Free providers are rate-limited, so only utterances that look aimed at me
// get an automatic call; everything else waits for the Answer button.
function looksAimedAtMe(text: string): boolean {
  const name = settings.myName.toLowerCase();
  const lower = text.toLowerCase();
  return lower.includes(name) || /\byou\b|\byour\b/.test(lower) || /\?\s*$/.test(text);
}

function underRateLimit(): boolean {
  const now = Date.now();
  while (callTimes.length && callTimes[0]! < now - 60_000) callTimes.shift();
  if (callTimes.length >= FREE_CALLS_PER_MINUTE) return false;
  callTimes.push(now);
  return true;
}

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header>
    <span id="status">Idle</span>
    <span id="meta"></span>
    <button id="settingsBtn" class="ghost" aria-label="Settings">⚙︎</button>
  </header>

  <main>
    <div id="answer" class="answer muted">Paste a board in settings, then start listening.</div>
    <div id="interim" class="interim"></div>
    <div id="lines" class="lines"></div>
  </main>

  <footer>
    <button id="listenBtn" class="primary">Start</button>
    <button id="answerBtn">Answer</button>
    <button id="nudgeBtn">Question</button>
    <label class="auto"><input type="checkbox" id="autoChk"> auto</label>
  </footer>

  <dialog id="settings">
    <form method="dialog">
      <h2>Settings</h2>
      <label>Provider
        <select id="provider">
          ${(Object.keys(PROVIDERS) as Provider[]).map((p) => `<option value="${p}">${PROVIDERS[p].label}</option>`).join("")}
        </select>
      </label>
      <div id="providerNote" class="hint"></div>
      <label>API key <input id="apiKey" type="password" autocomplete="off" placeholder="sk-…"></label>
      <label>Model <input id="model" type="text" autocomplete="off" spellcheck="false"></label>
      <label>Base URL <input id="baseUrl" type="url" autocomplete="off" spellcheck="false" placeholder="https://…/v1"></label>
      <label>My name <input id="myName" type="text"></label>
      <label>Language
        <select id="lang">
          <option value="en-US">English</option>
          <option value="de-DE">Deutsch</option>
        </select>
      </label>
      <label>Board <textarea id="boardText" rows="8" placeholder="OPENER — WORD FOR WORD …"></textarea></label>
      <div id="boardInfo" class="hint"></div>
      <menu>
        <button value="cancel" class="ghost">Close</button>
        <button id="saveBtn" value="save" class="primary">Save &amp; load board</button>
      </menu>
    </form>
  </dialog>
`;

const statusEl = $("status");
const metaEl = $("meta");
const answerEl = $("answer");
const interimEl = $("interim");
const linesEl = $("lines");
const listenBtn = $<HTMLButtonElement>("listenBtn");
const answerBtn = $<HTMLButtonElement>("answerBtn");
const nudgeBtn = $<HTMLButtonElement>("nudgeBtn");
const autoChk = $<HTMLInputElement>("autoChk");
const dialog = $<HTMLDialogElement>("settings");

// ---------- helpers ----------

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setMeta(text: string): void {
  metaEl.textContent = text;
}

function showAnswer(text: string, muted = false): void {
  answerEl.textContent = text;
  answerEl.classList.toggle("muted", muted);
}

function recentTranscript(): Utterance[] {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = transcript.filter((u) => u.at >= cutoff);
  return recent.slice(-MAX_LINES);
}

function renderLines(): void {
  linesEl.innerHTML = recentTranscript()
    .slice(-5)
    .map((u) => `<div>${escapeHtml(u.text)}</div>`)
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function loadBoard(): void {
  if (!settings.boardText.trim()) {
    board = null;
    systemPrompt = "";
    $("boardInfo").textContent = "No board loaded.";
    return;
  }
  board = parseBoard(settings.boardText);
  systemPrompt = buildSystemPrompt(board, settings.myName);
  questionIndex = 0;
  $("boardInfo").textContent = `${board.cards.length} cards, ${board.questions.length} questions, ~${Math.round(systemPrompt.length / 4)} tokens`;
}

async function keepScreenOn(): Promise<void> {
  try {
    wakeLock = await (navigator as any).wakeLock?.request("screen");
  } catch {
    // not supported or denied; the user keeps the screen on manually
  }
}

function releaseScreen(): void {
  try {
    wakeLock?.release();
  } catch {
    // ignore
  }
  wakeLock = null;
}

// ---------- answering ----------

async function ask(forced: boolean): Promise<void> {
  if (!settings.apiKey) {
    showAnswer("Add your API key in settings.", true);
    return;
  }
  if (!systemPrompt) {
    showAnswer("Paste a board in settings first.", true);
    return;
  }
  const window_ = recentTranscript();
  if (window_.length === 0) {
    showAnswer("Nothing heard yet.", true);
    return;
  }

  // Latest wins: a newer utterance cancels the answer in flight.
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  const askedAt = window_[window_.length - 1]!.at;
  answerEl.classList.add("thinking");

  try {
    const result = await answer({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt,
      transcript: window_,
      forced,
      signal: controller.signal,
      onFirstToken: () => setMeta(`${Date.now() - askedAt} ms`),
      onDelta: (text) => showAnswer(text),
    });
    if (controller.signal.aborted) return;
    if (result.silent) {
      answerEl.classList.add("muted");
    } else {
      showAnswer(result.text);
    }
    if (settings.provider === "anthropic") {
      const cache = result.cacheRead > 0 ? "cached" : result.cacheWrite > 0 ? "cache written" : "no cache";
      setMeta(`${metaEl.textContent} · ${cache}`);
    }
  } catch (err: any) {
    if (controller.signal.aborted) return;
    showAnswer(`Error: ${err?.message ?? String(err)}`, true);
  } finally {
    if (inflight === controller) inflight = null;
    answerEl.classList.remove("thinking");
  }
}

// ---------- speech ----------

const stt = new Stt(
  {
    onInterim: (text) => {
      interimEl.textContent = text;
    },
    onFinal: (u) => {
      transcript.push(u);
      interimEl.textContent = "";
      renderLines();
      // "okay", "yeah", "mhm": not worth a call.
      if (!settings.auto || u.text.split(/\s+/).length < 3) return;
      if (settings.provider === "anthropic") {
        void ask(false);
      } else if (looksAimedAtMe(u.text)) {
        if (underRateLimit()) void ask(false);
        else setMeta("rate limit: use Answer");
      }
    },
    onStatus: setStatus,
    onGaveUp: () => {
      releaseScreen();
      listenBtn.textContent = "Start";
      listenBtn.classList.remove("live");
    },
  },
  settings.lang,
);

function toggleListening(): void {
  if (stt.isListening()) {
    stt.stop();
    releaseScreen();
    listenBtn.textContent = "Start";
    listenBtn.classList.remove("live");
  } else {
    if (!sttSupported()) {
      showAnswer("This browser has no speech recognition. On iPhone, open this page in Safari.", true);
      return;
    }
    stt.start();
    void keepScreenOn();
    listenBtn.textContent = "Stop";
    listenBtn.classList.add("live");
  }
}

// ---------- wiring ----------

listenBtn.addEventListener("click", toggleListening);
answerBtn.addEventListener("click", () => void ask(true));
nudgeBtn.addEventListener("click", () => {
  if (!board || board.questions.length === 0) {
    showAnswer("No question bank in this board.", true);
    return;
  }
  showAnswer(board.questions[questionIndex % board.questions.length]!);
  questionIndex++;
});
autoChk.addEventListener("change", () => {
  settings.auto = autoChk.checked;
  saveSettings(settings);
});

function applyProviderDefaults(provider: Provider): void {
  const info = PROVIDERS[provider];
  $<HTMLInputElement>("model").value = info.model;
  $<HTMLInputElement>("baseUrl").value = info.baseUrl;
  $<HTMLInputElement>("baseUrl").disabled = provider === "anthropic";
  $("providerNote").textContent = info.note;
}

$<HTMLSelectElement>("provider").addEventListener("change", (e) => {
  applyProviderDefaults((e.target as HTMLSelectElement).value as Provider);
});

$("settingsBtn").addEventListener("click", () => {
  $<HTMLSelectElement>("provider").value = settings.provider;
  $<HTMLInputElement>("apiKey").value = settings.apiKey;
  $<HTMLInputElement>("myName").value = settings.myName;
  $<HTMLInputElement>("model").value = settings.model;
  $<HTMLInputElement>("baseUrl").value = settings.baseUrl;
  $<HTMLInputElement>("baseUrl").disabled = settings.provider === "anthropic";
  $("providerNote").textContent = PROVIDERS[settings.provider].note;
  $<HTMLSelectElement>("lang").value = settings.lang;
  $<HTMLTextAreaElement>("boardText").value = settings.boardText;
  dialog.showModal();
});

$("saveBtn").addEventListener("click", () => {
  settings.provider = $<HTMLSelectElement>("provider").value as Provider;
  settings.baseUrl = $<HTMLInputElement>("baseUrl").value.trim();
  settings.apiKey = $<HTMLInputElement>("apiKey").value.trim();
  settings.myName = $<HTMLInputElement>("myName").value.trim() || DEFAULTS.myName;
  settings.model = $<HTMLInputElement>("model").value.trim() || PROVIDERS[settings.provider].model;
  const lang = $<HTMLSelectElement>("lang").value;
  if (lang !== settings.lang) {
    settings.lang = lang;
    stt.setLang(lang);
  }
  settings.boardText = $<HTMLTextAreaElement>("boardText").value;
  saveSettings(settings);
  loadBoard();
  if (board && settings.apiKey) {
    setStatus("Warming cache…");
    warmCache(settings.provider, settings.apiKey, settings.model, systemPrompt)
      .then(() => setStatus(stt.isListening() ? "Listening" : "Ready"))
      .catch((err) => setStatus(`Cache warm failed: ${err?.message ?? err}`));
  }
  showAnswer(board ? "Board loaded. Start listening." : "No board loaded.", true);
});

// Re-acquire the wake lock when the tab comes back to the front.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stt.isListening()) void keepScreenOn();
});

// ---------- init ----------

autoChk.checked = settings.auto;
loadBoard();
if (board) showAnswer("Board loaded. Start listening.", true);
setStatus(sttSupported() ? "Ready" : "No speech recognition in this browser");
