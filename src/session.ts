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
  const date = first.toISOString().slice(0, 10);
  const header = `Live Board transcript, ${date}${boardName ? `, board: ${boardName}` : ""}`;
  const lines = entries.map((e) => (e.kind === "heard" ? `${clock(e.at)}  ${e.text}` : `${clock(e.at)}  → suggested: ${e.text}`));
  return [header, "", ...lines].join("\n");
}
