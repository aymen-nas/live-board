// Everything the app knows during a meeting, in one place.

import type { Board, Card } from "./board";
import { CallLimiter } from "./conversation";
import type { RemoteBoard } from "./github";
import type { IndexedBoard } from "./match";
import type { SessionEntry } from "./session";
import { fixProviderForKey, loadSettings } from "./settings";
import { simEnabled } from "./sim";
import type { Utterance } from "./stt";

export const SIM = simEnabled();

export const settings = loadSettings();
fixProviderForKey(settings);

export const state = {
  board: null as Board | null,
  index: null as IndexedBoard | null,
  systemPrompt: "",
  transcript: [] as Utterance[],
  session: [] as SessionEntry[], // what was heard and suggested, for Copy
  answers: [] as { at: number; text: string }[],
  shownQuestions: new Set<string>(),
  questionIndex: 0,
  currentCard: null as Card | null,
  lastAnswerAt: 0,
  remoteBoards: [] as RemoteBoard[],
};

// Routeway's free plan allows 5 calls a minute; Anthropic has no such cap here.
export const limiter = new CallLimiter(5);
export const isFree = (): boolean => settings.provider !== "anthropic";
export const underFreeLimit = (): boolean => !isFree() || limiter.left() > 0;
