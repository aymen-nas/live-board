import { describe, expect, it } from "vitest";
import { CallLimiter, looksAimedAt, recentIndexes, windowEndingAt, wordCount } from "../src/conversation";
import { DEFAULTS, cleanSecret, fixProviderForKey, loadSettings, saveSettings } from "../src/settings";

const line = (text: string, at: number) => ({ text, at });

describe("windowEndingAt", () => {
  const t = [line("old", 0), line("a", 100_000), line("b", 150_000), line("c", 185_000), line("later", 300_000)];
  it("keeps the 90 s before the chosen line, not after it", () => {
    expect(windowEndingAt(t, 3).map((u) => u.text)).toEqual(["a", "b", "c"]);
  });
  it("is empty for an index that doesn't exist", () => {
    expect(windowEndingAt(t, 9)).toEqual([]);
  });
  it("caps at 14 lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => line(`l${i}`, i * 1000));
    expect(windowEndingAt(many, 29)).toHaveLength(14);
  });
});

describe("recentIndexes", () => {
  it("returns the lines of the last 90 s", () => {
    const t = [line("old", 0), line("new", 100_000)];
    expect(recentIndexes(t, 150_000)).toEqual([1]);
  });
});

describe("looksAimedAt", () => {
  it("catches the name, you/your and questions", () => {
    expect(looksAimedAt("aymen where are we", "Aymen")).toBe(true);
    expect(looksAimedAt("what do you think", "Aymen")).toBe(true);
    expect(looksAimedAt("Is it live?", "Aymen")).toBe(true);
  });
  it("ignores lines for others", () => {
    expect(looksAimedAt("the trucks arrive next week", "Aymen")).toBe(false);
    expect(looksAimedAt("young people", "Aymen")).toBe(false);
  });
  it("doesn't match everything when the name is empty", () => {
    expect(looksAimedAt("the trucks arrive", "")).toBe(false);
  });
});

describe("wordCount", () => {
  it("counts words, not spaces", () => {
    expect(wordCount("  one  two three ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("CallLimiter", () => {
  it("frees a call 60 s after it was made", () => {
    const l = new CallLimiter(5);
    for (let i = 0; i < 5; i++) l.record(1_000 + i);
    expect(l.left(2_000)).toBe(0);
    expect(l.left(61_000)).toBe(1);
    expect(l.left(70_000)).toBe(5);
  });
});

describe("settings", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("round-trips and fills new fields from the defaults", () => {
    const s = store();
    s.setItem("live-board.settings", JSON.stringify({ apiKey: "k", myName: "X" }));
    const loaded = loadSettings(s);
    expect(loaded.apiKey).toBe("k");
    expect(loaded.ghRepo).toBe(DEFAULTS.ghRepo);
    saveSettings({ ...loaded, myName: "Y" }, s);
    expect(loadSettings(s).myName).toBe("Y");
  });
  it("survives broken JSON and unknown providers", () => {
    const s = store();
    s.setItem("live-board.settings", "{nope");
    expect(loadSettings(s)).toEqual(DEFAULTS);
    s.setItem("live-board.settings", JSON.stringify({ provider: "nope" }));
    expect(loadSettings(s).provider).toBe(DEFAULTS.provider);
  });
  it("moves a non-Anthropic key away from Anthropic", () => {
    const s = { ...DEFAULTS, provider: "anthropic" as const, apiKey: "sk-PX", baseUrl: "", model: "claude-haiku-5-5" };
    fixProviderForKey(s);
    expect(s.provider).toBe("routeway");
    expect(s.baseUrl).toContain("routeway");
  });
  it("strips whitespace from pasted secrets", () => {
    expect(cleanSecret(" sk-abc\n123 ")).toBe("sk-abc123");
  });
});
