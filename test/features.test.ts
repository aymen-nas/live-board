import { describe, expect, it } from "vitest";
import { parseBoard } from "../src/board";
import { bestCard, bestQuestion, indexBoard, tokenize } from "../src/match";
import { defaultBoardName, deleteBoard, listBoards, saveBoard } from "../src/library";
import { exportSession } from "../src/session";

const SEP = "══════════";
const BOARD = parseBoard(
  [
    "OPENER — WORD FOR WORD",
    "Quick update.",
    SEP,
    "CLUELY PRIMER",
    "Always answer in English. Cost and staging everywhere, but this card must never match.",
    SEP,
    "COST",
    "Today it costs about 25 euros a month. The estimate for the new rhythm is 4 to 5 times that, confirmed after the test day.",
    SEP,
    "THE TEST RUN",
    "The staging city runs every 2 minutes since yesterday evening. First runs looked healthy, about 1 second per run.",
    SEP,
    "MATTERMOST DELIVERY",
    "One Mattermost message per alert in a dedicated channel. PT gets added at the end.",
    SEP,
    "QUESTION BANK",
    "Questions to pick from, word for word. Do you still want the alerts in the chat channel? Is there a maximum number of pings per hour you'd accept? Should alerts run until 22:00 or only office hours?",
  ].join("\n"),
);

describe("tokenize", () => {
  it("keeps content words and acronyms, drops fillers", () => {
    const t = tokenize("Okay so PT asked about the Mattermost channel, yeah, and the SES quota");
    expect(t.has("pt")).toBe(true);
    expect(t.has("ses")).toBe(true);
    expect(t.has("mattermost")).toBe(true);
    expect(t.has("channel")).toBe(true);
    expect(t.has("okay")).toBe(false);
    expect(t.has("yeah")).toBe(false);
    expect(t.has("the")).toBe(false);
  });
});

describe("bestCard", () => {
  const index = indexBoard(BOARD);

  it("finds the card for the current topic, title words weigh double", () => {
    expect(bestCard(index, "how much is the faster rhythm going to cost per month")?.title).toBe("COST");
    expect(bestCard(index, "is the staging city test run healthy since yesterday")?.title).toBe("THE TEST RUN");
  });

  it("never returns the primer or the question bank", () => {
    const card = bestCard(index, "always answer in english, cost and staging everywhere", 1);
    expect(card).not.toBeNull();
    expect(card!.title).not.toMatch(/PRIMER|QUESTION BANK/);
  });

  it("returns nothing for small talk", () => {
    expect(bestCard(index, "good morning everyone, let's get started")).toBeNull();
  });
});

describe("bestQuestion", () => {
  const index = indexBoard(BOARD);

  it("suggests the question that fits the topic", () => {
    expect(bestQuestion(index, "PT wants pings in the chat channel instead of mails")).toBe(
      "Do you still want the alerts in the chat channel?",
    );
  });

  it("skips questions already shown", () => {
    const shown = new Set(["Do you still want the alerts in the chat channel?"]);
    expect(bestQuestion(index, "alerts in the chat channel", shown)).not.toBe("Do you still want the alerts in the chat channel?");
  });
});

describe("board library", () => {
  function memory(): Pick<Storage, "getItem" | "setItem"> {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  }

  it("saves, replaces by name, lists newest first, deletes", () => {
    const kv = memory();
    saveBoard("Standup", "a", kv, 1);
    saveBoard("PT oversight", "b", kv, 2);
    saveBoard("Standup", "c", kv, 3);
    expect(listBoards(kv).map((b) => [b.name, b.text])).toEqual([
      ["Standup", "c"],
      ["PT oversight", "b"],
    ]);
    deleteBoard("Standup", kv);
    expect(listBoards(kv).map((b) => b.name)).toEqual(["PT oversight"]);
  });

  it("names a board after the date and its first real card", () => {
    const name = defaultBoardName(`OPENER — WORD FOR WORD\nHi\n${SEP}\nCLUELY PRIMER\nx\n${SEP}\nCOST\ny`, new Date(2026, 10, 7).getTime());
    expect(name).toBe("07.11 COST");
  });
});

describe("exportSession", () => {
  it("prints heard lines and suggestions with clock times", () => {
    const t0 = new Date(2026, 10, 7, 14, 5, 9).getTime();
    const text = exportSession(
      [
        { at: t0, kind: "heard", text: "Aymen, is the test running?" },
        { at: t0 + 2000, kind: "answer", text: "Yes, since yesterday evening." },
      ],
      "07.11 COST",
    );
    expect(text).toContain("board: 07.11 COST");
    expect(text).toContain("14:05:09  Aymen, is the test running?");
    expect(text).toContain("14:05:11  → suggested: Yes, since yesterday evening.");
  });

  it("is empty when nothing was heard", () => {
    expect(exportSession([])).toBe("");
  });
});
