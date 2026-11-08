// The meeting survives a reload ("Update ready", iOS evicting the app): the
// transcript, the session log and the answers are saved on this phone with
// every new line, and restored when the app opens again within 30 minutes of
// the last one. Older meetings are deleted, so a morning meeting doesn't run
// into the afternoon one.

import type { SessionEntry } from "./session";
import type { Utterance } from "./stt";

const KEY = "live-board.meeting";
const MAX_AGE_MS = 30 * 60_000;

export interface SavedMeeting {
  savedAt: number;
  transcript: Utterance[];
  session: SessionEntry[];
  answers: { at: number; text: string; seq?: number }[];
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function saveMeeting(m: Omit<SavedMeeting, "savedAt">, now = Date.now(), store: Store = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify({ ...m, savedAt: now }));
  } catch {
    // storage full or blocked: the meeting just won't survive a reload
  }
}

export function loadMeeting(now = Date.now(), store: Store = localStorage): SavedMeeting | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as SavedMeeting;
    // Age from the last line heard (like the check on resume), not the last save.
    const lastLine = Array.isArray(m?.transcript) ? m.transcript[m.transcript.length - 1]?.at : undefined;
    if (!m || !Array.isArray(m.transcript) || now - (lastLine ?? m.savedAt) > MAX_AGE_MS) {
      store.removeItem(KEY); // too old or broken: don't keep the room's transcript around
      return null;
    }
    return { savedAt: m.savedAt, transcript: m.transcript, session: m.session ?? [], answers: m.answers ?? [] };
  } catch {
    clearMeeting(store);
    return null;
  }
}

export function clearMeeting(store: Store = localStorage): void {
  try {
    store.removeItem(KEY);
  } catch {
    // ignore
  }
}
