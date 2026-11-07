// Saved boards on the phone, so switching between today's meetings is two
// taps instead of a paste. Stored in localStorage next to the settings.

export interface SavedBoard {
  name: string;
  text: string;
  savedAt: number;
}

const KEY = "live-board.boards";
const MAX_BOARDS = 30;

type KV = Pick<Storage, "getItem" | "setItem">;

function store(): KV | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function listBoards(kv: KV | null = store()): SavedBoard[] {
  try {
    const raw = kv?.getItem(KEY);
    const boards = raw ? (JSON.parse(raw) as SavedBoard[]) : [];
    return boards.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function write(boards: SavedBoard[], kv: KV | null): void {
  try {
    kv?.setItem(KEY, JSON.stringify(boards.slice(0, MAX_BOARDS)));
  } catch {
    // storage full or blocked; the active board still works
  }
}

export function saveBoard(name: string, text: string, kv: KV | null = store(), now = Date.now()): void {
  const clean = name.trim() || defaultBoardName(text, now);
  const boards = listBoards(kv).filter((b) => b.name !== clean);
  boards.unshift({ name: clean, text, savedAt: now });
  write(boards, kv);
}

export function deleteBoard(name: string, kv: KV | null = store()): void {
  write(
    listBoards(kv).filter((b) => b.name !== name),
    kv,
  );
}

// "07.11 WHO SAYS WHAT TODAY": the date plus the first real card title.
export function defaultBoardName(text: string, now = Date.now()): string {
  const d = new Date(now);
  const date = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  const titles = text
    .split(/═{5,}/)
    .map((s) => s.trim().split("\n")[0]?.trim() ?? "")
    .filter((t) => t && !/^OPENER|PRIMER/i.test(t));
  const title = (titles[0] ?? "Board").slice(0, 40);
  return `${date} ${title}`;
}
