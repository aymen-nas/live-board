// The settings sheet: boards from the GitHub repo, boards saved on this
// phone, the pasted board, and provider/key/language.

import { preconnect } from "./connection";
import { newMeeting, stt } from "./listening";
import { fetchRemoteBoard, listRemoteBoards } from "./github";
import { defaultBoardName, deleteBoard, listBoards, saveBoard } from "./library";
import { PROVIDERS, warmCache, type Provider } from "./llm";
import { DEFAULTS, cleanSecret, fixProviderForKey, providerForKey } from "./settings";
import { SIM, persistSettings, settings, state } from "./state";
import { $, els, escapeHtml, setStatus } from "./ui";
import { loadBoard, renderRate, showNotice } from "./view";

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

// What the user picked in this visit; a background sync must not undo it.
let userPicked = "";
let visit = 0; // bumped on every open, so a late board download can't save a later visit's form

function renderRemote(): void {
  const select = $<HTMLSelectElement>("remote");
  const boards = state.remoteBoards;
  select.innerHTML = boards.length
    ? boards.map((b) => `<option value="${escapeHtml(b.path)}">${escapeHtml(b.name)}</option>`).join("")
    : `<option value="">${settings.ghToken ? "No boards found" : "Add a GitHub token below"}</option>`;
  select.disabled = boards.length === 0;
  $<HTMLButtonElement>("remoteLoad").disabled = select.disabled;
  const current = boards.find((b) => b.name === settings.boardName);
  if (userPicked && boards.some((b) => b.path === userPicked)) select.value = userPicked;
  else if (current) select.value = current.path;
}

let syncSeq = 0;

export async function syncRemote(quiet = false): Promise<void> {
  if (!settings.ghToken || !settings.ghRepo) {
    state.remoteBoards = [];
    renderRemote();
    return;
  }
  const seq = ++syncSeq; // only the latest listing counts
  if (!quiet) $("remoteInfo").textContent = "Syncing…";
  try {
    const { boards, broadToken } = await listRemoteBoards({ repo: settings.ghRepo, token: settings.ghToken });
    if (seq !== syncSeq) return;
    state.remoteBoards = boards;
    $("remoteInfo").textContent =
      `${boards.length} boards in ${settings.ghRepo}` + (broadToken ? ". This token can do more than read: a fine-grained read-only one is safer." : "");
  } catch (err) {
    if (seq !== syncSeq) return;
    $("remoteInfo").textContent = err instanceof Error ? err.message : String(err);
  }
  renderRemote();
}

// Loads a board from the repo and makes it the active one, in one tap.
async function useRemote(path: string): Promise<void> {
  const meta = state.remoteBoards.find((b) => b.path === path);
  if (!meta) return;
  $("remoteInfo").textContent = "Loading…";
  const thisVisit = visit;
  try {
    const text = await fetchRemoteBoard({ repo: settings.ghRepo, token: settings.ghToken }, path);
    // Closed with Close (edits discarded) or reopened since: don't save that form.
    // (After Save the form holds what was saved, so applying the board is fine.)
    if (thisVisit !== visit) return;
    // Put it in the form and save the whole form, so a key typed in the same
    // visit is kept too.
    $<HTMLTextAreaElement>("boardText").value = text;
    input("boardName").value = meta.name;
    saveFromDialog();
    $("remoteInfo").textContent = `Using ${meta.name}`;
    if (els.settings.open) els.settings.close();
  } catch (err) {
    if (thisVisit !== visit) return;
    $("remoteInfo").textContent = err instanceof Error ? err.message : String(err);
  }
}

function applyProviderDefaults(provider: Provider): void {
  const info = PROVIDERS[provider];
  input("model").value = info.model;
  input("baseUrl").value = info.baseUrl;
  input("baseUrl").disabled = provider === "anthropic";
  $("providerNote").textContent = info.note;
  // Don't carry a key over to a provider it doesn't belong to (Custom takes
  // any key except an Anthropic one, like fixProviderForKey).
  const owner = providerForKey(cleanSecret(input("apiKey").value));
  if (owner && owner !== provider && (provider !== "custom" || owner === "anthropic")) input("apiKey").value = "";
}

function readGitHubFields(): void {
  settings.ghRepo = input("ghRepo").value.trim() || DEFAULTS.ghRepo;
  settings.ghToken = cleanSecret(input("ghToken").value);
}

export function openSettings(): void {
  userPicked = "";
  visit++;
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
  // First run: the key is the first thing to fill in, so open that section
  // and bring it into view.
  const section = $<HTMLDetailsElement>("providerSection");
  section.open = !settings.apiKey;
  els.settings.showModal();
  if (!settings.apiKey) section.scrollIntoView({ block: "start" });
  void syncRemote(true);
}

function saveFromDialog(): void {
  const before = { board: settings.boardText, name: settings.myName, provider: settings.provider, key: settings.apiKey };
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
  if (settings.boardText.trim() && !SIM) saveBoard(settings.boardName, settings.boardText);
  persistSettings();
  // Reload the board only when it changed: that resets topic and questions.
  const boardChanged = settings.boardText !== before.board || settings.myName !== before.name;
  if (boardChanged) loadBoard();
  preconnect();
  renderRate();
  const promptChanged = boardChanged || settings.provider !== before.provider || settings.apiKey !== before.key;
  if (promptChanged && state.board && settings.apiKey && settings.provider === "anthropic") {
    setStatus("Warming cache…");
    warmCache(settings.provider, settings.apiKey, settings.model, state.systemPrompt)
      .then(() => setStatus(stt.isListening() ? "Listening" : "Ready"))
      .catch((err) => setStatus(`Cache warm failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  if ((boardChanged || settings.apiKey !== before.key) && !stt.isListening()) {
    showNotice(
      !settings.apiKey
        ? "Add your API key under Provider, key and language to get answers."
        : state.board
          ? `${settings.boardName} loaded. Start listening.`
          : settings.apiKey !== before.key
            ? "Key saved. Step 2: tap ⚙︎ and pick a board."
            : "No board loaded.",
      true,
    );
  }
}

export function initSettings(): void {
  $("settingsBtn").addEventListener("click", openSettings);
  // Save is the form's only submit button, so Return/Go on the keyboard saves.
  $("saveBtn").addEventListener("click", saveFromDialog);
  $("closeBtn").addEventListener("click", () => {
    visit++; // discard: a board download still running must not save this form
    els.settings.close();
  });
  els.settings.addEventListener("cancel", () => visit++); // Escape / swipe-to-dismiss
  $<HTMLSelectElement>("provider").addEventListener("change", (e) => {
    applyProviderDefaults((e.target as HTMLSelectElement).value as Provider);
  });
  $("remoteLoad").addEventListener("click", () => void useRemote($<HTMLSelectElement>("remote").value));
  $<HTMLSelectElement>("remote").addEventListener("change", (e) => {
    userPicked = (e.target as HTMLSelectElement).value;
  });
  $("remoteSync").addEventListener("click", () => {
    readGitHubFields();
    persistSettings();
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
  $("clearBtn").addEventListener("click", () => newMeeting("Transcript cleared."));
}
