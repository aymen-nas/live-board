import { describe, expect, it } from "vitest";
import { buildSystemPrompt, parseBoard, splitQuestions } from "../src/board";

const SEP = "══════════";

const BOARD = [
  "OPENER — WORD FOR WORD",
  "Thanks for the time. First line of the opener.",
  "──────────",
  "IF ASKED WHEN — WORD FOR WORD: After the test day.",
  SEP,
  "CLUELY PRIMER",
  "Always answer in English. You help me, Aymen, live in a meeting. Numbers as digits.",
  SEP,
  "AI NEWS — WHAT CHANGES FOR PT",
  "PT-safe. We check for news every minute instead of every 2 hours.",
  SEP,
  "QUESTION BANK",
  "Questions to pick from, word for word. Is a Mattermost ping still what you want? Should it run until 23:00 or only trading hours? Who from PT should be in the channel?",
].join("\n");

describe("parseBoard", () => {
  it("splits opener, primer, cards and questions", () => {
    const board = parseBoard(BOARD);
    expect(board.opener).toContain("First line of the opener.");
    expect(board.opener).toContain("IF ASKED WHEN");
    expect(board.primer).toMatch(/^Always answer in English/);
    expect(board.cards.map((c) => c.title)).toEqual([
      "CLUELY PRIMER",
      "AI NEWS — WHAT CHANGES FOR PT",
      "QUESTION BANK",
    ]);
    expect(board.cards[1]!.body).toBe("PT-safe. We check for news every minute instead of every 2 hours.");
    expect(board.questions).toHaveLength(3);
  });

  it("tolerates Windows line endings and separator lines without newlines", () => {
    const board = parseBoard(BOARD.replace(/\n/g, "\r\n"));
    expect(board.cards).toHaveLength(3);
  });

  it("handles a board with no opener", () => {
    const board = parseBoard(`CLUELY PRIMER\nAlways answer in English.\n${SEP}\nONE CARD\nBody.`);
    expect(board.opener).toBe("");
    expect(board.cards).toHaveLength(2);
    expect(board.questions).toEqual([]);
  });
});

describe("splitQuestions", () => {
  it("drops the lead-in and keeps only questions", () => {
    expect(splitQuestions("Questions to pick from, word for word. A one? B two? Not a question.")).toEqual([
      "A one?",
      "B two?",
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("starts with the primer, includes the opener and every non-primer card, and the silence rule", () => {
    const board = parseBoard(BOARD);
    const prompt = buildSystemPrompt(board, "Aymen");
    expect(prompt.startsWith(board.primer)).toBe(true);
    expect(prompt).toContain("## OPENER — WORD FOR WORD");
    expect(prompt).toContain("## AI NEWS — WHAT CHANGES FOR PT");
    expect(prompt).toContain("## QUESTION BANK");
    expect(prompt).not.toContain("## CLUELY PRIMER");
    expect(prompt).toContain("reply with exactly one character: —");
    expect(prompt).toContain("Aymen");
  });

  it("falls back to a default primer when the board has none", () => {
    const prompt = buildSystemPrompt(parseBoard("ONE CARD\nBody."), "Sam");
    expect(prompt).toMatch(/^Always answer in English\. You help me, Sam/);
  });
});
