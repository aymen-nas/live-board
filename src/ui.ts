// The page: markup, element handles and small display helpers. Importing
// this module mounts the app, so it must be imported before anything that
// touches the DOM.

import { PROVIDERS, type Provider } from "./llm";
import { sttSupported } from "./stt";

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header>
    <span id="status" role="status">Idle</span>
    <span id="meta"></span>
    <span id="rate" class="rate" title="Calls left this minute"></span>
    <button id="updateBtn" class="update" hidden>Update ready · tap</button>
    <button id="copyBtn" class="icon" aria-label="Copy transcript">⧉</button>
    <button id="settingsBtn" class="icon" aria-label="Settings">⚙︎</button>
  </header>

  <main>
    <section id="answerArea" class="answer-area">
      <div id="answer" class="answer muted"></div>
      <div id="history" class="history" aria-label="Earlier answers"></div>
    </section>
    <div id="chips" class="chips"></div>
    <div id="interim" class="interim" aria-hidden="true"></div>
    <div id="lines" class="lines" role="group" aria-label="Recent lines. Tap one to get an answer for it."></div>
    <div id="announce" class="visually-hidden" aria-live="polite"></div>
  </main>

  <footer>
    <button id="listenBtn" class="primary">Start</button>
    <button id="answerBtn">Answer</button>
    <button id="nudgeBtn">Question</button>
    <label class="auto" title="Answer automatically"><input type="checkbox" id="autoChk"> auto</label>
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
      <label>Board name <input id="boardName" type="text" autocomplete="off" placeholder="07.11 Weekly sync"></label>
      <label>Board <textarea id="boardText" rows="7" placeholder="OPENER — WORD FOR WORD …"></textarea></label>
      <div id="boardInfo" class="hint"></div>
      <details id="providerSection">
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
        <button id="closeBtn" type="button" class="ghost">Close</button>
        <button id="saveBtn" value="save" class="primary">Save &amp; load board</button>
      </menu>
    </form>
  </dialog>
`;

export const els = {
  status: $("status"),
  meta: $("meta"),
  rate: $("rate"),
  update: $<HTMLButtonElement>("updateBtn"),
  answerArea: $("answerArea"),
  answer: $("answer"),
  announce: $("announce"),
  history: $("history"),
  chips: $("chips"),
  interim: $("interim"),
  lines: $("lines"),
  listen: $<HTMLButtonElement>("listenBtn"),
  answerBtn: $<HTMLButtonElement>("answerBtn"),
  nudge: $<HTMLButtonElement>("nudgeBtn"),
  copy: $<HTMLButtonElement>("copyBtn"),
  auto: $<HTMLInputElement>("autoChk"),
  settings: $<HTMLDialogElement>("settings"),
  card: $<HTMLDialogElement>("cardView"),
};

export function setStatus(text: string): void {
  els.status.textContent = text;
}

export function setMeta(text: string): void {
  els.meta.textContent = text;
}

export function showAnswer(text: string, muted = false): void {
  els.answer.textContent = text;
  els.answer.classList.toggle("muted", muted);
  els.answer.classList.remove("error");
}

export function showError(text: string): void {
  els.answer.textContent = text;
  els.answer.classList.remove("muted");
  els.answer.classList.add("error");
}

// A new answer: glow, and scroll it into view if the history was scrolled.
export function flash(): void {
  els.answer.classList.remove("fresh");
  void els.answer.offsetWidth; // restart the animation
  els.answer.classList.add("fresh");
  els.answerArea.scrollTop = 0;
}

// Screen readers hear each finished answer once, not every streamed word.
export function announce(text: string): void {
  els.announce.textContent = text;
}

// A sheet from the bottom, not a modal: an answer arriving meanwhile stays visible above it.
export function showCard(title: string, body: string): void {
  $("cardTitle").textContent = title;
  $("cardBody").textContent = body;
  if (!els.card.open) els.card.show();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Shown next to mic errors so the environment is obvious at a glance:
// "Safari iOS 18.1 · home-screen app" explains most failures.
export function environment(): string {
  const ua = navigator.userAgent;
  const browser = /CriOS/.test(ua) ? "Chrome iOS" : /FxiOS/.test(ua) ? "Firefox iOS" : /EdgiOS/.test(ua) ? "Edge iOS" : /Safari/.test(ua) && /iPhone|iPad/.test(ua) ? "Safari iOS" : /Chrome\//.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "other browser";
  const ios = ua.match(/OS (\d+)_(\d+)/);
  const version = ios ? ` ${ios[1]}.${ios[2]}` : "";
  const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return `${browser}${version} · ${standalone ? "home-screen app" : "tab"} · ${sttSupported() ? "recognition available" : "no recognition"}`;
}
