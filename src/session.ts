// What was heard and answered during the meeting, for the Copy button:
// paste it into a chat afterwards to get follow-ups and notes.

export interface SessionEntry {
  at: number;
  kind: "heard" | "answer";
  text: string;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function exportSession(entries: SessionEntry[], boardName = ""): string {
  if (entries.length === 0) return "";
  const first = new Date(entries[0]!.at);
  // Local date, like the clock times below (toISOString would give UTC: yesterday's date just after midnight).
  const date = [first.getFullYear(), first.getMonth() + 1, first.getDate()].map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0")).join("-");
  const header = `Live Board transcript, ${date}${boardName ? `, board: ${boardName}` : ""}`;
  const lines = entries.map((e) => (e.kind === "heard" ? `${clock(e.at)}  ${e.text}` : `${clock(e.at)}  → suggested: ${e.text}`));
  return [header, "", ...lines].join("\n");
}
