// The settings sheet: boards from the GitHub repo, boards saved on this
// phone, the pasted board, and provider/key/language.

import { preconnect } from "./connection";
import { resetListening, stt } from "./listening";
import { fetchRemoteBoard, listRemoteBoards } from "./github";
import { defaultBoardName, deleteBoard, listBoards, saveBoard } from "./library";
import { PROVIDERS, warmCache, type Provider } from "./llm";
import { DEFAULTS, cleanSecret, fixProviderForKey, saveSettings } from "./settings";
import { settings, state } from "./state";
import { $, els, escapeHtml, setStatus, showAnswer } from "./ui";
import { loadBoard, renderChips, renderHistory, renderLines, renderRate } from "./view";

const input = (id: string) => $<HTMLInputElement>(id);

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
  const boards = state.remoteBoards;
  select.innerHTML = boards.length
    ? boards.map((b) => `<option value="${escapeHtml(b.path)}">${escapeHtml(b.name)}</option>`).join("")
    : `<option value="">${settings.ghToken ? "No boards found" : "Add a GitHub token below"}</option>`;
  select.disabled = boards.length === 0;
  const current = boards.find((b) => b.name === settings.boardName);
  if (current) select.value = current.path;
}

export async function syncRemote(quiet = false): Promise<void> {
  if (!settings.ghToken || !settings.ghRepo) {
    state.remoteBoards = [];
    renderRemote();
    return;
  }
  if (!quiet) $("remoteInfo").textContent = "Syncing…";
  try {
    state.remoteBoards = await listRemoteBoards({ repo: settings.ghRepo, token: settings.ghToken });
    $("remoteInfo").textContent = `${state.remoteBoards.length} boards in ${settings.ghRepo}`;
  } catch (err) {
    $("remoteInfo").textContent = err instanceof Error ? err.message : String(err);
  }
  renderRemote();
}

// Loads a board from the repo and makes it the active one, in one tap.
async function useRemote(path: string): Promise<void> {
  const meta = state.remoteBoards.find((b) => b.path === path);
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
    input("boardName").value = meta.name;
    $("remoteInfo").textContent = `Using ${meta.name}`;
    showAnswer(`${meta.name} loaded. Start listening.`, true);
    els.settings.close();
  } catch (err) {
    $("remoteInfo").textContent = err instanceof Error ? err.message : String(err);
  }
}

function applyProviderDefaults(provider: Provider): void {
  const info = PROVIDERS[provider];
  input("model").value = info.model;
  input("baseUrl").value = info.baseUrl;
  input("baseUrl").disabled = provider === "anthropic";
  $("providerNote").textContent = info.note;
}

function readGitHubFields(): void {
  settings.ghRepo = input("ghRepo").value.trim() || DEFAULTS.ghRepo;
  settings.ghToken = cleanSecret(input("ghToken").value);
}

export function openSettings(): void {
  $<HTMLSelectElement>("provider").value = settings.provider;
  input("apiKey").value = settings.apiKey;
  input("myName").value = settings.myName;
  input("model").value = settings.model;
  input("baseUrl").value = settings.baseUrl;
  input("baseUrl").disabled = settings.provider === "anthropic";
  $("providerNote").textContent = PROVIDERS[settings.provider].note;
  $<HTMLSelectElement>("lang").value = settings.lang;
  input("boardName").value = settings.boardName;
  $<HTMLTextAreaElement>("boardText").value = settings.boardText;
  input("ghRepo").value = settings.ghRepo;
  input("ghToken").value = settings.ghToken;
  renderLibrary();
  renderRemote();
  els.settings.showModal();
  void syncRemote(true);
}

function saveFromDialog(): void {
  settings.provider = $<HTMLSelectElement>("provider").value as Provider;
  settings.baseUrl = input("baseUrl").value.trim();
  settings.apiKey = cleanSecret(input("apiKey").value);
  settings.myName = input("myName").value.trim() || DEFAULTS.myName;
  settings.model = input("model").value.trim() || PROVIDERS[settings.provider].model;
  fixProviderForKey(settings);
  readGitHubFields();
  const lang = $<HTMLSelectElement>("lang").value;
  if (lang !== settings.lang) {
    settings.lang = lang;
    stt.setLang(lang);
  }
  settings.boardText = $<HTMLTextAreaElement>("boardText").value;
  settings.boardName = settings.boardText.trim() ? input("boardName").value.trim() || defaultBoardName(settings.boardText) : "";
  if (settings.boardText.trim()) saveBoard(settings.boardName, settings.boardText);
  saveSettings(settings);
  loadBoard();
  preconnect();
  renderRate();
  if (state.board && settings.apiKey && settings.provider === "anthropic") {
    setStatus("Warming cache…");
    warmCache(settings.provider, settings.apiKey, settings.model, state.systemPrompt)
      .then(() => setStatus(stt.isListening() ? "Listening" : "Ready"))
      .catch((err) => setStatus(`Cache warm failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  showAnswer(state.board ? `${settings.boardName} loaded. Start listening.` : "No board loaded.", true);
}

function clearTranscript(): void {
  resetListening();
  state.transcript.length = 0;
  state.session.length = 0;
  state.answers.length = 0;
  state.shownQuestions.clear();
  state.currentCard = null;
  renderLines();
  renderHistory();
  renderChips(null);
  showAnswer("Transcript cleared.", true);
}

export function initSettings(): void {
  $("settingsBtn").addEventListener("click", openSettings);
  $("saveBtn").addEventListener("click", saveFromDialog);
  $<HTMLSelectElement>("provider").addEventListener("change", (e) => {
    applyProviderDefaults((e.target as HTMLSelectElement).value as Provider);
  });
  $("remoteLoad").addEventListener("click", () => void useRemote($<HTMLSelectElement>("remote").value));
  $("remoteSync").addEventListener("click", () => {
    readGitHubFields();
    saveSettings(settings);
    void syncRemote();
  });
  $("libLoad").addEventListener("click", () => {
    const saved = listBoards().find((b) => b.name === $<HTMLSelectElement>("library").value);
    if (!saved) return;
    input("boardName").value = saved.name;
    $<HTMLTextAreaElement>("boardText").value = saved.text;
  });
  $("libDelete").addEventListener("click", () => {
    const name = $<HTMLSelectElement>("library").value;
    if (!name) return;
    deleteBoard(name);
    renderLibrary();
  });
  $("clearBtn").addEventListener("click", clearTranscript);
}
