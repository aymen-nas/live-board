import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARLY_MS, EarlyFire, type EarlyHooks } from "../src/early";

function setup(over: Partial<EarlyHooks> = {}) {
  const fired: string[] = [];
  const settled: { index: number; text: string; reask: boolean }[] = [];
  const hooks: EarlyHooks = {
    wanted: (t) => /aymen/i.test(t),
    canCall: () => true,
    fire: (t) => fired.push(t) - 1,
    settle: (index, text, reask) => void settled.push({ index, text, reask }),
    ...over,
  };
  return { early: new EarlyFire(hooks), fired, settled };
}

describe("EarlyFire", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once the live text is stable for 600 ms", () => {
    const { early, fired } = setup();
    early.interim("Aymen where are we with");
    vi.advanceTimersByTime(EARLY_MS - 100);
    early.interim("Aymen where are we with the alerts");
    vi.advanceTimersByTime(EARLY_MS - 1);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["Aymen where are we with the alerts"]);
  });

  it("ignores short or not-for-me text", () => {
    const { early, fired } = setup();
    early.interim("Aymen quick one");
    early.interim("the trucks arrive next week on Monday");
    vi.advanceTimersByTime(5_000);
    expect(fired).toEqual([]);
  });

  it("swallows the matching final without a re-ask when it adds little", () => {
    const { early, settled } = setup();
    early.interim("Aymen where are we with the alerts");
    vi.advanceTimersByTime(EARLY_MS);
    expect(early.final("Aymen, where are we with the alerts?", Date.now() + 500)).toBe(true);
    expect(settled).toEqual([{ index: 0, text: "Aymen, where are we with the alerts?", reask: false }]);
  });

  it("asks again when the final adds 4 or more words", () => {
    const { early, settled } = setup();
    early.interim("Aymen can you tell us");
    vi.advanceTimersByTime(EARLY_MS);
    early.final("Aymen, can you tell us what the faster rhythm costs?", Date.now());
    expect(settled[0]!.reask).toBe(true);
  });

  it("lets an unrelated final through as a new line", () => {
    const { early, settled } = setup();
    early.interim("Aymen where are we with the alerts");
    vi.advanceTimersByTime(EARLY_MS);
    early.interim("Okay");
    expect(early.final("Okay next topic", Date.now())).toBe(false);
    expect(settled).toEqual([]);
  });

  it("does not fire when the free limit is used up", () => {
    const { early, fired } = setup({ canCall: () => false });
    early.interim("Aymen where are we with the alerts");
    vi.advanceTimersByTime(EARLY_MS);
    expect(fired).toEqual([]);
  });

  it("a final cancels a pending timer, and reset forgets the fired line", () => {
    const { early, fired } = setup();
    early.interim("Aymen where are we with the alerts");
    early.final("Aymen where are we with the alerts", Date.now());
    vi.advanceTimersByTime(EARLY_MS);
    expect(fired).toEqual([]);
    early.interim("Aymen what does it cost per month");
    vi.advanceTimersByTime(EARLY_MS);
    early.reset();
    expect(early.final("Aymen what does it cost per month?", Date.now())).toBe(false);
  });
});
