import "./style.css";
import { buildSystemPrompt, parseBoard, type Board, type Card } from "./board";
import { PROVIDERS, answer, preloadProvider, warmCache, type Provider } from "./llm";
import { Stt, sttSupported, type SttCallbacks, type Utterance } from "./stt";
import { SimStt, devKey, loadSimBoard, simEnabled, simLog } from "./sim";
import { bestCard, bestQuestion, indexBoard, sameSentence, type IndexedBoard } from "./match";
import { defaultBoardName, deleteBoard, listBoards, saveBoard } from "./library";
import { exportSession, type SessionEntry } from "./session";
import { fetchRemoteBoard, listRemoteBoards, type RemoteBoard } from "./github";
import { setupUpdates } from "./update";

// ---------- persisted settings ----------

interface Settings {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  myName: string;
  model: string;
  lang: string;
  boardText: string;
  boardName: string;
  auto: boolean;
  ghRepo: string;
  ghToken: string;
}

const DEFAULTS: Settings = {
  provider: "routeway",
  baseUrl: PROVIDERS.routeway.baseUrl,
  apiKey: "",
  myName: "Aymen",
  model: PROVIDERS.routeway.model,
  lang: "en-US",
  boardText: "",
  boardName: "",
  auto: true,
  ghRepo: "aymen-nas/live-board-boards",
  ghToken: "",
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("live-board.settings");
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

// An Anthropic key always starts with "sk-ant-". Anything else sent to
// Anthropic fails as "invalid key", so move it to Routeway instead of
// making the user find the dropdown.
function fixProviderForKey(s: Settings): void {
  if (s.provider === "anthropic" && s.apiKey && !s.apiKey.startsWith("sk-ant-")) {
    s.provider = "routeway";
    s.baseUrl = PROVIDERS.routeway.baseUrl;
    s.model = PROVIDERS.routeway.model;
  }
  if (s.provider !== "anthropic" && !s.baseUrl) s.baseUrl = PROVIDERS[s.provider].baseUrl;
  if (!s.model) s.model = PROVIDERS[s.provider].model;
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem("live-board.settings", JSON.stringify(s));
  } catch {
    // private mode or storage blocked: the session still works, just not persisted
  }
}

// ---------- state ----------

const SIM = simEnabled();
const settings = loadSettings();
fixProviderForKey(settings);
let board: Board | null = null;
let index: IndexedBoard | null = null;
let systemPrompt = "";
const transcript: Utterance[] = [];
const session: SessionEntry[] = [];
const answers: { at: number; text: string }[] = [];
const shownQuestions = new Set<string>();
let inflight: AbortController | null = null;
let questionIndex = 0;
let wakeLock: any = null;
let currentCard: Card | null = null;
let remoteBoards: RemoteBoard[] = [];

const WINDOW_MS = 90_000;
const MAX_LINES = 14;
const FREE_CALLS_PER_MINUTE = 5; // Routeway's free plan; Gemini's free tier is higher
const HISTORY = 3; // previous answers kept visible under the current one
const callTimes: number[] = [];

const isFree = (): boolean => settings.provider !== "anthropic";

// Free providers are rate-limited, so only utterances that look aimed at me
// get an automatic call; everything else waits for the Answer button.
function looksAimedAtMe(text: string): boolean {
  const name = settings.myName.toLowerCase();
  const lower = text.toLowerCase();
  return lower.includes(name) || /\byou\b|\byour\b/.test(lower) || /\?\s*$/.test(text);
}

function callsLastMinute(): number {
  const now = Date.now();
  while (callTimes.length && callTimes[0]! < now - 60_000) callTimes.shift();
  return callTimes.length;
}

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header>
    <span id="status">Idle</span>
    <span id="meta"></span>
    <span id="rate" class="rate" title="Calls left this minute"></span>
    <button id="updateBtn" class="update" hidden>Update ready · tap</button>
    <button id="settingsBtn" class="ghost" aria-label="Settings">⚙︎</button>
  </header>

  <main>
    <div id="answer" class="answer muted">Paste a board in settings, then start listening.</div>
    <div id="history" class="history"></div>
    <div id="chips" class="chips"></div>
    <div id="interim" class="interim"></div>
    <div id="lines" class="lines" aria-label="Tap a line to answer it"></div>
  </main>

  <footer>
    <button id="listenBtn" class="primary">Start</button>
    <button id="answerBtn">Answer</button>
    <button id="nudgeBtn">Question</button>
    <button id="copyBtn" class="ghost" aria-label="Copy transcript">⧉</button>
    <label class="auto"><input type="checkbox" id="autoChk"> auto</label>
  </footer>

  <dialog id="cardView">
    <form method="dialog">
      <h2 id="cardTitle"></h2>
      <p id="cardBody" class="card-body"></p>
      <menu><button value="close" class="primary">Close</button></menu>
    </form>
  </dialog>

  <dialog id="settings">
    <form method="dialog">
      <h2>Settings</h2>
      <label>Boards from Claude
        <span class="row">
          <select id="remote"></select>
          <button id="remoteLoad" type="button" class="primary">Use</button>
          <button id="remoteSync" type="button" class="ghost" aria-label="Refresh">↻</button>
        </span>
      </label>
      <div id="remoteInfo" class="hint"></div>
      <label>Saved on this phone
        <span class="row">
          <select id="library"></select>
          <button id="libLoad" type="button">Load</button>
          <button id="libDelete" type="button" class="ghost">Delete</button>
        </span>
      </label>
      <label>Board name <input id="boardName" type="text" autocomplete="off" placeholder="07.11 PT oversight"></label>
      <label>Board <textarea id="boardText" rows="7" placeholder="OPENER — WORD FOR WORD …"></textarea></label>
      <div id="boardInfo" class="hint"></div>
      <details>
        <summary>Provider, key and language</summary>
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
        <label>Boards repository <input id="ghRepo" type="text" autocomplete="off" spellcheck="false" placeholder="owner/name"></label>
        <label>GitHub token (read-only) <input id="ghToken" type="password" autocomplete="off" placeholder="github_pat_…"></label>
        <button id="clearBtn" type="button" class="ghost">New meeting: clear transcript</button>
      </details>
      <menu>
        <button value="cancel" class="ghost">Close</button>
        <button id="saveBtn" value="save" class="primary">Save &amp; load board</button>
      </menu>
    </form>
  </dialog>
`;

const statusEl = $("status");
const metaEl = $("meta");
const rateEl = $("rate");
const answerEl = $("answer");
const historyEl = $("history");
const chipsEl = $("chips");
const interimEl = $("interim");
const linesEl = $("lines");
const listenBtn = $<HTMLButtonElement>("listenBtn");
const answerBtn = $<HTMLButtonElement>("answerBtn");
const nudgeBtn = $<HTMLButtonElement>("nudgeBtn");
const copyBtn = $<HTMLButtonElement>("copyBtn");
const autoChk = $<HTMLInputElement>("autoChk");
const dialog = $<HTMLDialogElement>("settings");
const cardDialog = $<HTMLDialogElement>("cardView");

// ---------- helpers ----------

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// Shown next to mic errors so the environment is obvious at a glance:
// "Safari iOS 18.1 · home-screen app" explains most failures.
function environment(): string {
  const ua = navigator.userAgent;
  const browser = /CriOS/.test(ua) ? "Chrome iOS" : /FxiOS/.test(ua) ? "Firefox iOS" : /EdgiOS/.test(ua) ? "Edge iOS" : /Safari/.test(ua) && /iPhone|iPad/.test(ua) ? "Safari iOS" : /Chrome\//.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "other browser";
  const ios = ua.match(/OS (\d+)_(\d+)/);
  const version = ios ? ` ${ios[1]}.${ios[2]}` : "";
  const standalone = (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return `${browser}${version} · ${standalone ? "home-screen app" : "tab"} · ${sttSupported() ? "recognition available" : "no recognition"}`;
}

function setMeta(text: string): void {
  metaEl.textContent = text;
}

function renderRate(): void {
  rateEl.textContent = isFree() ? `${Math.max(0, FREE_CALLS_PER_MINUTE - callsLastMinute())}/${FREE_CALLS_PER_MINUTE}` : "";
}

function showAnswer(text: string, muted = false): void {
  answerEl.textContent = text;
  answerEl.classList.toggle("muted", muted);
}

function flash(): void {
  answerEl.classList.remove("fresh");
  void answerEl.offsetWidth; // restart the animation
  answerEl.classList.add("fresh");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function recentIndexes(): number[] {
  const cutoff = Date.now() - WINDOW_MS;
  const out: number[] = [];
  transcript.forEach((u, i) => {
    if (u.at >= cutoff) out.push(i);
  });
  return out.slice(-MAX_LINES);
}

// The window the model sees: everything up to `upto` within 90 seconds of it.
function windowEndingAt(upto: number): Utterance[] {
  const end = transcript[upto];
  if (!end) return [];
  return transcript
    .slice(0, upto + 1)
    .filter((u) => u.at >= end.at - WINDOW_MS)
    .slice(-MAX_LINES);
}

function renderLines(): void {
  linesEl.innerHTML = recentIndexes()
    .slice(-5)
    .map((i) => `<button class="line" data-i="${i}">${escapeHtml(transcript[i]!.text)}</button>`)
    .join("");
}

function renderHistory(): void {
  // answers[last] is on screen; show the ones before it, newest first.
  historyEl.innerHTML = answers
    .slice(0, -1)
    .slice(-HISTORY)
    .reverse()
    .map((a) => `<div>${escapeHtml(a.text)}</div>`)
    .join("");
}

function renderChips(questionChip: string | null): void {
  const parts: string[] = [];
  if (currentCard) parts.push(`<button class="chip" id="cardChip">📌 ${escapeHtml(currentCard.title)}</button>`);
  if (questionChip) parts.push(`<button class="chip q" id="questionChip">💡 ${escapeHtml(questionChip)}</button>`);
  chipsEl.innerHTML = parts.join("");
  $("cardChip")?.addEventListener("click", () => {
    if (!currentCard) return;
    $("cardTitle").textContent = currentCard.title;
    $("cardBody").textContent = currentCard.body;
    cardDialog.showModal();
  });
  $("questionChip")?.addEventListener("click", () => {
    if (!questionChip) return;
    showAnswer(questionChip);
    flash();
    shownQuestions.add(questionChip);
    renderChips(null);
  });
}

// Topic tracking on every utterance; no API call.
let lastAnswerAt = 0;
function updateContext(): void {
  if (!index) return;
  const recentText = transcript
    .slice(-3)
    .map((u) => u.text)
    .join(" ");
  currentCard = bestCard(index, recentText) ?? currentCard;
  // Offer a question only when no answer has come in the last minute.
  const quiet = Date.now() - lastAnswerAt > 60_000;
  const q = quiet ? bestQuestion(index, recentText, shownQuestions) : null;
  renderChips(q);
}

function loadBoard(): void {
  if (!settings.boardText.trim()) {
    board = null;
    index = null;
    systemPrompt = "";
    $("boardInfo").textContent = "No board loaded.";
    return;
  }
  board = parseBoard(settings.boardText);
  index = indexBoard(board);
  systemPrompt = buildSystemPrompt(board, settings.myName);
  questionIndex = 0;
  shownQuestions.clear();
  currentCard = null;
  renderChips(null);
  $("boardInfo").textContent = `${board.cards.length} cards, ${board.questions.length} questions, ~${Math.round(systemPrompt.length / 4)} tokens`;
}

function renderLibrary(): void {
  const boards = listBoards();
  const select = $<HTMLSelectElement>("library");
  select.innerHTML = boards.length
    ? boards.map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join("")
    : `<option value="">No saved boards yet</option>`;
  select.disabled = boards.length === 0;
  if (settings.boardName) select.value = settings.boardName;
}

function renderRemote(): void {
  const select = $<HTMLSelectElement>("remote");
  select.innerHTML = remoteBoards.length
    ? remoteBoards.map((b) => `<option value="${escapeHtml(b.path)}">${escapeHtml(b.name)}</option>`).join("")
    : `<option value="">${settings.ghToken ? "No boards found" : "Add a GitHub token below"}</option>`;
  select.disabled = remoteBoards.length === 0;
  const current = remoteBoards.find((b) => b.name === settings.boardName);
  if (current) select.value = current.path;
}

async function syncRemote(quiet = false): Promise<void> {
  if (!settings.ghToken || !settings.ghRepo) {
    remoteBoards = [];
    renderRemote();
    return;
  }
  if (!quiet) $("remoteInfo").textContent = "Syncing…";
  try {
    remoteBoards = await listRemoteBoards({ repo: settings.ghRepo, token: settings.ghToken });
    $("remoteInfo").textContent = `${remoteBoards.length} boards in ${settings.ghRepo}`;
  } catch (err: any) {
    $("remoteInfo").textContent = String(err?.message ?? err);
  }
  renderRemote();
}

// Loads a board from the repo and makes it the active one, in one tap.
async function useRemote(path: string): Promise<void> {
  const meta = remoteBoards.find((b) => b.path === path);
  if (!meta) return;
  $("remoteInfo").textContent = "Loading…";
  try {
    const text = await fetchRemoteBoard({ repo: settings.ghRepo, token: settings.ghToken }, path);
    settings.boardText = text;
    settings.boardName = meta.name;
    saveBoard(meta.name, text); // keep a copy for offline use
    saveSettings(settings);
    loadBoard();
    $<HTMLTextAreaElement>("boardText").value = text;
    $<HTMLInputElement>("boardName").value = meta.name;
    $("remoteInfo").textContent = `Using ${meta.name}`;
    showAnswer(`${meta.name} loaded. Start listening.`, true);
    dialog.close();
  } catch (err: any) {
    $("remoteInfo").textContent = String(err?.message ?? err);
  }
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

async function ask(forced: boolean, upto = transcript.length - 1): Promise<void> {
  if (!settings.apiKey) {
    showAnswer("Add your API key in settings.", true);
    return;
  }
  if (!systemPrompt) {
    showAnswer("Paste a board in settings first.", true);
    return;
  }
  const window_ = windowEndingAt(upto);
  if (window_.length === 0) {
    showAnswer("Nothing heard yet.", true);
    return;
  }

  // Latest wins: a newer request cancels the answer in flight.
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  const askedAt = forced ? Date.now() : window_[window_.length - 1]!.at;
  answerEl.classList.add("thinking");
  callTimes.push(Date.now());
  renderRate();

  // Keep the answer on screen as history before replacing it.
  let replaced = false;

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
      onDelta: (text) => {
        if (!replaced) {
          replaced = true;
          flash();
        }
        showAnswer(text);
      },
    });
    if (controller.signal.aborted) return;
    if (result.silent) {
      // Nothing for me: put the previous answer back if streaming had started.
      const last = answers[answers.length - 1];
      if (last) showAnswer(last.text);
      answerEl.classList.add("muted");
    } else {
      showAnswer(result.text);
      answers.push({ at: Date.now(), text: result.text });
      session.push({ at: Date.now(), kind: "answer", text: result.text });
      lastAnswerAt = Date.now();
      renderHistory();
      renderChips(null);
    }
    if (SIM) simLog.push({ at: Date.now(), kind: result.silent ? "silent" : "answer", text: result.text, ms: Date.now() - askedAt });
    if (settings.provider === "anthropic") {
      const cache = result.cacheRead > 0 ? "cached" : result.cacheWrite > 0 ? "cache written" : "no cache";
      setMeta(`${metaEl.textContent} · ${cache}`);
    }
  } catch (err: any) {
    if (controller.signal.aborted) return;
    const msg = String(err?.message ?? err);
    showAnswer(/429/.test(msg) ? "Rate limit reached; wait a few seconds." : `Error: ${msg}`, true);
    if (SIM) simLog.push({ at: Date.now(), kind: "error", text: msg });
  } finally {
    if (inflight === controller) inflight = null;
    answerEl.classList.remove("thinking");
  }
}

// ---------- early fire ----------
// The speech engine marks a sentence final only after a pause. When the live
// text is aimed at me and has stopped changing for 600 ms, answer it already;
// the final result then replaces the text and only asks again if it added a lot.

const EARLY_MS = 600;
const EARLY_MIN_WORDS = 5;
const REASK_EXTRA_WORDS = 4;
let earlyTimer: number | null = null;
let early: { index: number; text: string; entry: SessionEntry; firedAt: number } | null = null;

const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

function underFreeLimit(): boolean {
  return !isFree() || callsLastMinute() < FREE_CALLS_PER_MINUTE;
}

function fireEarly(text: string): void {
  earlyTimer = null;
  if (early || !underFreeLimit()) return;
  const now = Date.now();
  const entry: SessionEntry = { at: now, kind: "heard", text };
  transcript.push({ text, at: now });
  session.push(entry);
  early = { index: transcript.length - 1, text, entry, firedAt: now };
  renderLines();
  updateContext();
  if (SIM) simLog.push({ at: now, kind: "early", text });
  void ask(false, early.index);
}

// Returns true when the final belonged to the early-fired sentence.
function settleEarly(u: Utterance): boolean {
  if (!early) return false;
  const e = early;
  early = null;
  if (!sameSentence(e.text, u.text)) return false; // that sentence never got a final; keep it as heard
  transcript[e.index] = { text: u.text, at: transcript[e.index]!.at };
  e.entry.text = u.text;
  renderLines();
  updateContext();
  const gained = u.at - e.firedAt;
  if (SIM) simLog.push({ at: u.at, kind: "final-after-early", text: u.text, ms: gained });
  if (wordCount(u.text) - wordCount(e.text) >= REASK_EXTRA_WORDS && underFreeLimit()) {
    void ask(false, e.index);
  } else if (!answerEl.classList.contains("thinking")) {
    setMeta(`${metaEl.textContent} · ${gained} ms early`);
  }
  return true;
}

// ---------- speech ----------

const sttCallbacks: SttCallbacks = {
  onInterim: (text) => {
    interimEl.textContent = text;
    if (earlyTimer !== null) window.clearTimeout(earlyTimer);
    earlyTimer = null;
    if (!text) return;
    // A new sentence started while the early one never got a final: keep it as heard.
    if (early && !sameSentence(early.text, text)) early = null;
    if (early || !settings.auto || wordCount(text) < EARLY_MIN_WORDS || !looksAimedAtMe(text)) return;
    earlyTimer = window.setTimeout(() => fireEarly(text), EARLY_MS);
  },
  onFinal: (u) => {
    if (earlyTimer !== null) window.clearTimeout(earlyTimer);
    earlyTimer = null;
    interimEl.textContent = "";
    if (settleEarly(u)) return;
    transcript.push(u);
    session.push({ at: u.at, kind: "heard", text: u.text });
    renderLines();
    updateContext();
    // "okay", "yeah", "mhm": not worth a call.
    if (!settings.auto || wordCount(u.text) < 3) return;
    if (!isFree()) {
      void ask(false);
    } else if (looksAimedAtMe(u.text)) {
      if (underFreeLimit()) void ask(false);
      else setMeta("rate limit: tap a line or Answer");
    }
  },
  onStatus: (text) => {
    setStatus(text);
    if (text.startsWith("Mic error") || text.startsWith("Speech service")) setMeta(environment());
  },
  onGaveUp: () => {
    keepWarm(false);
    releaseScreen();
    listenBtn.textContent = "Start";
    listenBtn.classList.remove("live");
  },
};

const stt: Stt | SimStt = SIM ? new SimStt(sttCallbacks) : new Stt(sttCallbacks, settings.lang);

// ---------- warm connection ----------
// A cold call pays DNS, TCP and TLS before the request even leaves (a few
// round trips on mobile). Open the connection early and keep it open while
// listening with a tiny request that doesn't count as a model call.

let warmTimer: number | null = null;

function apiOrigin(): string | null {
  if (settings.provider === "anthropic") return "https://api.anthropic.com";
  try {
    return new URL(settings.baseUrl).origin;
  } catch {
    return null;
  }
}

function preconnect(): void {
  preloadProvider(settings.provider);
  const origin = apiOrigin();
  if (!origin || document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.crossOrigin = "anonymous"; // same connection pool as the API calls (no cookies)
  document.head.append(link);
}

function pingApi(): void {
  const origin = apiOrigin();
  if (origin) fetch(`${origin}/`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
}

function keepWarm(on: boolean): void {
  if (warmTimer !== null) window.clearInterval(warmTimer);
  warmTimer = null;
  if (!on) return;
  pingApi();
  warmTimer = window.setInterval(pingApi, 45_000);
}

function toggleListening(): void {
  if (stt.isListening()) {
    stt.stop();
    keepWarm(false);
    releaseScreen();
    listenBtn.textContent = "Start";
    listenBtn.classList.remove("live");
  } else {
    if (!SIM && !sttSupported()) {
      showAnswer("This browser has no speech recognition. On iPhone, any browser works; on a computer, use Chrome or Safari.", true);
      return;
    }
    stt.start();
    keepWarm(true);
    void keepScreenOn();
    listenBtn.textContent = "Stop";
    listenBtn.classList.add("live");
  }
}

// ---------- wiring ----------

listenBtn.addEventListener("click", toggleListening);
answerBtn.addEventListener("click", () => void ask(true));

// Tap a transcript line to get the answer to exactly that line.
linesEl.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>(".line");
  if (!target) return;
  const i = Number(target.dataset.i);
  if (Number.isInteger(i)) void ask(true, i);
});

nudgeBtn.addEventListener("click", () => {
  if (!board || board.questions.length === 0) {
    showAnswer("No question bank in this board.", true);
    return;
  }
  const q = board.questions[questionIndex % board.questions.length]!;
  showAnswer(q);
  flash();
  shownQuestions.add(q);
  questionIndex++;
});

copyBtn.addEventListener("click", async () => {
  const text = exportSession(session, settings.boardName);
  if (!text) {
    setStatus("Nothing to copy yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${session.length} lines`);
  } catch {
    // Clipboard blocked: show it so it can be selected by hand.
    $("cardTitle").textContent = "Transcript";
    $("cardBody").textContent = text;
    cardDialog.showModal();
  }
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

$("remoteLoad").addEventListener("click", () => void useRemote($<HTMLSelectElement>("remote").value));
$("remoteSync").addEventListener("click", () => {
  settings.ghRepo = $<HTMLInputElement>("ghRepo").value.trim() || DEFAULTS.ghRepo;
  settings.ghToken = $<HTMLInputElement>("ghToken").value.replace(/\s+/g, "");
  saveSettings(settings);
  void syncRemote();
});

$("libLoad").addEventListener("click", () => {
  const name = $<HTMLSelectElement>("library").value;
  const saved = listBoards().find((b) => b.name === name);
  if (!saved) return;
  $<HTMLInputElement>("boardName").value = saved.name;
  $<HTMLTextAreaElement>("boardText").value = saved.text;
});

$("libDelete").addEventListener("click", () => {
  const name = $<HTMLSelectElement>("library").value;
  if (!name) return;
  deleteBoard(name);
  renderLibrary();
});

$("clearBtn").addEventListener("click", () => {
  transcript.length = 0;
  session.length = 0;
  answers.length = 0;
  shownQuestions.clear();
  currentCard = null;
  renderLines();
  renderHistory();
  renderChips(null);
  showAnswer("Transcript cleared.", true);
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
  $<HTMLInputElement>("boardName").value = settings.boardName;
  $<HTMLTextAreaElement>("boardText").value = settings.boardText;
  $<HTMLInputElement>("ghRepo").value = settings.ghRepo;
  $<HTMLInputElement>("ghToken").value = settings.ghToken;
  renderLibrary();
  renderRemote();
  dialog.showModal();
  void syncRemote(true);
});

$("saveBtn").addEventListener("click", () => {
  settings.provider = $<HTMLSelectElement>("provider").value as Provider;
  settings.baseUrl = $<HTMLInputElement>("baseUrl").value.trim();
  // Pasted keys often carry a space or line break from the copy.
  settings.apiKey = $<HTMLInputElement>("apiKey").value.replace(/\s+/g, "");
  settings.myName = $<HTMLInputElement>("myName").value.trim() || DEFAULTS.myName;
  settings.model = $<HTMLInputElement>("model").value.trim() || PROVIDERS[settings.provider].model;
  fixProviderForKey(settings);
  settings.ghRepo = $<HTMLInputElement>("ghRepo").value.trim() || DEFAULTS.ghRepo;
  settings.ghToken = $<HTMLInputElement>("ghToken").value.replace(/\s+/g, "");
  const lang = $<HTMLSelectElement>("lang").value;
  if (lang !== settings.lang) {
    settings.lang = lang;
    stt.setLang(lang);
  }
  settings.boardText = $<HTMLTextAreaElement>("boardText").value;
  settings.boardName = settings.boardText.trim()
    ? $<HTMLInputElement>("boardName").value.trim() || defaultBoardName(settings.boardText)
    : "";
  if (settings.boardText.trim()) saveBoard(settings.boardName, settings.boardText);
  saveSettings(settings);
  loadBoard();
  preconnect();
  renderRate();
  if (board && settings.apiKey && settings.provider === "anthropic") {
    setStatus("Warming cache…");
    warmCache(settings.provider, settings.apiKey, settings.model, systemPrompt)
      .then(() => setStatus(stt.isListening() ? "Listening" : "Ready"))
      .catch((err) => setStatus(`Cache warm failed: ${err?.message ?? err}`));
  }
  showAnswer(board ? `${settings.boardName} loaded. Start listening.` : "No board loaded.", true);
});

// Re-acquire the wake lock when the tab comes back to the front.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stt.isListening()) void keepScreenOn();
});

// The free-plan counter refills as calls age out of the last minute.
window.setInterval(renderRate, 5_000);

// ---------- init ----------

autoChk.checked = settings.auto;
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
  const btn = $<HTMLButtonElement>("updateBtn");
  btn.hidden = false;
  btn.onclick = reload;
});
if (board) showAnswer(`${settings.boardName || "Board"} loaded. Start listening.`, true);
setStatus(sttSupported() ? "Ready" : "No speech recognition in this browser");
if (!sttSupported()) setMeta(environment());
