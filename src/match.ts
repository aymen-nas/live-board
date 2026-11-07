// Cheap, offline matching between what's being said and the board: which
// card is the current topic, and which question-bank question fits it.
// No API call, so it runs on every utterance.

import type { Board, Card } from "./board";

const STOPWORDS = new Set(
  (
    "about above after again against also although always another anything are aren because been before being below " +
    "between both cannot could couldn did didn does doesn doing done down during each either else enough even ever every " +
    "first from further have haven having here hers herself himself however into itself just know like made make many " +
    "might more most much must myself need never next nothing once only other others ought ours ourselves over own " +
    "please quite rather really same should shouldn since some something still such sure than that that's their theirs " +
    "them themselves then there these they thing things think this those though through thus today together tomorrow " +
    "too under until upon very want was wasn well were weren what when where whether which while whom whose will with " +
    "within without would wouldn yeah yes yesterday your yours yourself yourselves okay sorry thanks thank going " +
    "get got good great right let's lets one two three said says say tell told question questions maybe kind sort " +
    // German fillers that show up in mixed meetings
    "aber also auch dann dass dein diese dieser eine einen einem einer haben hier jetzt kann können mein mehr nicht " +
    "noch oder schon sein sind über und unsere unser wenn werden wird wir wieder"
  ).split(/\s+/),
);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    // Keep acronyms like PT, SES, LLM, EIX even when short.
    const acronym = raw.length >= 2 && raw === raw.toUpperCase() && /\p{L}/u.test(raw);
    if (acronym || (lower.length >= 4 && !STOPWORDS.has(lower))) out.add(lower);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export interface IndexedBoard {
  cards: { card: Card; titleTokens: Set<string>; bodyTokens: Set<string> }[];
  questions: { text: string; tokens: Set<string> }[];
}

const SKIP_CARD = /PRIMER|QUESTION BANK/i;

export function indexBoard(board: Board): IndexedBoard {
  return {
    cards: board.cards
      .filter((c) => !SKIP_CARD.test(c.title))
      .map((card) => ({ card, titleTokens: tokenize(card.title), bodyTokens: tokenize(card.body) })),
    questions: board.questions.map((text) => ({ text, tokens: tokenize(text) })),
  };
}

// Title words count double: a card called "COST" is the place for a cost question.
export function bestCard(index: IndexedBoard, recentText: string, minScore = 3): Card | null {
  const q = tokenize(recentText);
  if (q.size === 0) return null;
  let best: Card | null = null;
  let bestScore = 0;
  for (const c of index.cards) {
    const score = 2 * overlap(q, c.titleTokens) + overlap(q, c.bodyTokens);
    if (score > bestScore) {
      best = c.card;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? best : null;
}

export function bestQuestion(
  index: IndexedBoard,
  recentText: string,
  exclude: Set<string> = new Set(),
  minScore = 2,
): string | null {
  const q = tokenize(recentText);
  if (q.size === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const item of index.questions) {
    if (exclude.has(item.text)) continue;
    const score = overlap(q, item.tokens);
    if (score > bestScore) {
      best = item.text;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? best : null;
}

// Is `later` the same sentence as `early` (the live text answered before the
// final arrived)? The final repeats it with punctuation fixed and sometimes a
// word changed, often the name ("Amen" -> "Aymen"), or carries on past it.
export function sameSentence(early: string, later: string): boolean {
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const a = words(early);
  const b = words(later);
  if (a.length === 0 || b.length === 0) return false;
  if (a.slice(0, 3).join(" ") === b.slice(0, 3).join(" ")) return true;
  const inLater = new Set(b);
  return a.filter((w) => inLater.has(w)).length >= 0.6 * a.length;
}
