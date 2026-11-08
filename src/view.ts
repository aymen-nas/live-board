// Renders the meeting state: transcript lines, answer history, topic and
// question chips, the free-plan counter, and the loaded board.

import { buildSystemPrompt, parseBoard } from "./board";
import { bestCard, bestQuestion, indexBoard } from "./match";
import { limiter, settings, state } from "./state";
import { $, els, escapeHtml, flash, showAnswer, showCard } from "./ui";

const VISIBLE_LINES = 5;
const HISTORY = 3; // previous answers kept visible under the current one
const QUIET_MS = 60_000; // offer a question only after a minute without an answer

let chipQuestion: string | null = null;

export function renderLines(): void {
  // The last few lines, however old: a tap answers with the 90 s before that line.
  const from = Math.max(0, state.transcript.length - VISIBLE_LINES);
  els.lines.innerHTML = state.transcript
    .slice(from)
    .map((u, k) => `<button class="line" data-i="${from + k}">${escapeHtml(u.text)}</button>`)
    .join("");
  els.lines.scrollTop = els.lines.scrollHeight; // newest line in view
}

export function renderHistory(): void {
  // Every finished answer except the one on screen, newest first.
  els.history.innerHTML = state.answers
    .filter((a) => a.seq !== state.shownSeq)
    .slice(-HISTORY)
    .reverse()
    .map((a) => `<div>${escapeHtml(a.text)}</div>`)
    .join("");
}

export function renderRate(): void {
  const l = limiter();
  els.rate.textContent = l ? `${l.left()}/${l.perMinute}` : "";
}

export function renderChips(question: string | null): void {
  chipQuestion = question;
  const parts: string[] = [];
  if (state.currentCard) parts.push(`<button class="chip" data-chip="card">📌 ${escapeHtml(state.currentCard.title)}</button>`);
  if (question) parts.push(`<button class="chip q" data-chip="question">💡 ${escapeHtml(question)}</button>`);
  els.chips.innerHTML = parts.join("");
}

// Something that isn't a model answer takes the answer area: the answer
// that was there moves to the history instead of vanishing.
export function showNotice(text: string, muted = true): void {
  state.shownSeq = 0;
  showAnswer(text, muted);
  renderHistory();
}

export function showQuestion(q: string): void {
  showNotice(q, false);
  flash();
  state.shownQuestions.add(q);
}

// One listener for both chips, set up once.
export function initChips(): void {
  els.chips.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-chip]");
    if (chip?.dataset.chip === "card" && state.currentCard) {
      showCard(state.currentCard.title, state.currentCard.body);
    } else if (chip?.dataset.chip === "question" && chipQuestion) {
      showQuestion(chipQuestion);
      renderChips(null);
    }
  });
}

// Topic tracking on every utterance; no API call.
export function updateContext(): void {
  if (!state.index) return;
  const recentText = state.transcript
    .slice(-3)
    .map((u) => u.text)
    .join(" ");
  state.currentCard = bestCard(state.index, recentText) ?? state.currentCard;
  const quiet = Date.now() - state.lastAnswerAt > QUIET_MS;
  renderChips(quiet ? bestQuestion(state.index, recentText, state.shownQuestions) : null);
}

export function loadBoard(): void {
  state.questionIndex = 0;
  state.shownQuestions.clear();
  state.currentCard = null;
  renderChips(null);
  if (!settings.boardText.trim()) {
    state.board = null;
    state.index = null;
    state.systemPrompt = "";
    $("boardInfo").textContent = "No board loaded.";
    return;
  }
  const board = parseBoard(settings.boardText);
  state.board = board;
  state.index = indexBoard(board);
  state.systemPrompt = buildSystemPrompt(board, settings.myName);
  $("boardInfo").textContent = `${board.cards.length} cards, ${board.questions.length} questions, ~${Math.round(state.systemPrompt.length / 4)} tokens`;
}
