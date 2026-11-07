// Parses the board format we already use for Cluely:
//   OPENER — WORD FOR WORD
//   <opener lines, optionally split by ──────────>
//   ══════════
//   TITLE IN CAPS
//   <one paragraph>
//   ══════════
//   ...
//   QUESTION BANK
//   Questions to pick from, word for word. Q1? Q2? ...

export interface Card {
  title: string;
  body: string;
}

export interface Board {
  opener: string;
  cards: Card[];
  primer: string;
  questions: string[];
}

const CARD_SEP = /\n?═{5,}\n?/;

export function parseBoard(text: string): Board {
  const sections = text
    .replace(/\r\n/g, "\n")
    .split(CARD_SEP)
    .map((s) => s.trim())
    .filter(Boolean);

  let opener = "";
  const cards: Card[] = [];

  for (const section of sections) {
    const nl = section.indexOf("\n");
    const title = (nl === -1 ? section : section.slice(0, nl)).trim();
    const body = nl === -1 ? "" : section.slice(nl + 1).trim();
    if (/^OPENER/i.test(title)) {
      opener = body;
    } else {
      cards.push({ title, body });
    }
  }

  const primer = cards.find((c) => /PRIMER/i.test(c.title))?.body ?? "";
  const bank = cards.find((c) => /QUESTION BANK/i.test(c.title))?.body ?? "";

  return { opener, cards, primer, questions: splitQuestions(bank) };
}

// "Questions to pick from, word for word. A? B? C?" -> ["A?", "B?", "C?"]
export function splitQuestions(bank: string): string[] {
  const withoutLead = bank.replace(/^Questions to pick from[^.]*\.\s*/i, "");
  return withoutLead
    .split(/(?<=\?)\s+/)
    .map((q) => q.trim())
    .filter((q) => q.endsWith("?"));
}

// The system prompt: primer first (stable), then every card. Nothing volatile
// goes in here, so the whole block stays cacheable across the meeting.
export function buildSystemPrompt(board: Board, myName: string): string {
  const cardText = board.cards
    .filter((c) => !/PRIMER/i.test(c.title))
    .map((c) => `## ${c.title}\n${c.body}`)
    .join("\n\n");

  const openerText = board.opener ? `## OPENER — WORD FOR WORD\n${board.opener}\n\n` : "";

  return [
    board.primer || `Always answer in English. You help me, ${myName}, live in a meeting.`,
    "",
    "You receive the live transcript of the meeting. Lines are in order; the last line is the newest and is marked LATEST. The transcript comes from speech recognition, so names and numbers may be garbled; read through that.",
    `If the LATEST line is aimed at me, ${myName}, or clearly invites me to speak, reply with the exact words I say next: 1 to 3 short spoken sentences, no lead-in, no quotes, no markdown.`,
    "If the LATEST line is not aimed at me, reply with exactly one character: —",
    "When I explicitly ask you to ANSWER, always answer, even if the line wasn't aimed at me.",
    "",
    "# BOARD",
    "",
    openerText + cardText,
  ].join("\n");
}
