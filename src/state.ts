// Everything the app knows during a meeting, in one place.

import type { Board, Card } from "./board";
import { CallLimiter } from "./conversation";
import type { RemoteBoard } from "./github";
import type { IndexedBoard } from "./match";
import type { SessionEntry } from "./session";
import { PROVIDERS } from "./llm";
import { clearMeeting, saveMeeting } from "./meeting";
import { fixProviderForKey, loadSettings, saveSettings } from "./settings";
import { simEnabled } from "./sim";
import type { Utterance } from "./stt";

export const SIM = simEnabled();

export interface Answer {
  at: number;
  text: string;
  seq: number;
}

export const settings = loadSettings();
fixProviderForKey(settings);

export const state = {
  board: null as Board | null,
  index: null as IndexedBoard | null,
  systemPrompt: "",
  transcript: [] as Utterance[],
  session: [] as SessionEntry[], // what was heard and suggested, for Copy
  // Finished answers in call order. `seq` is the call that made each one;
  // the answer whose seq is shownSeq is the one on screen (not in history).
  answers: [] as Answer[],
  shownSeq: 0,
  shownQuestions: new Set<string>(),
  questionIndex: 0,
  currentCard: null as Card | null,
  lastAnswerAt: 0,
  remoteBoards: [] as RemoteBoard[],
};

// Free plans cap calls per minute (Routeway: 5). The limiter keeps the
// counter honest; providers without a cap aren't limited.
const limiters = new Map<number, CallLimiter>();
export function limiter(): CallLimiter | null {
  const rpm = PROVIDERS[settings.provider].rpm;
  if (!rpm) return null;
  let l = limiters.get(rpm);
  if (!l) limiters.set(rpm, (l = new CallLimiter(rpm)));
  return l;
}
export const underFreeLimit = (): boolean => (limiter()?.left() ?? 1) > 0;
// Paid providers answer every line; the others only lines aimed at me.
export const everyLine = (): boolean => PROVIDERS[settings.provider].everyLine;

// ?sim borrows a sample board (and in dev a key) without saving them.
export function persistSettings(): void {
  if (!SIM) saveSettings(settings);
}

// Save the meeting at most once a second (it survives a reload; see meeting.ts).
let saveTimer: number | null = null;
export function rememberMeeting(): void {
  if (SIM || saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveMeeting({ transcript: state.transcript, session: state.session, answers: state.answers });
  }, 1_000);
}

// Save right away (the app is being hidden, reloaded or evicted).
export function flushMeeting(): void {
  if (saveTimer === null) return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  saveMeeting({ transcript: state.transcript, session: state.session, answers: state.answers });
}

export function forgetMeeting(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = null;
  if (!SIM) clearMeeting();
}
