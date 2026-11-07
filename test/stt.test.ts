import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Stt, type SttCallbacks } from "../src/stt";

class FakeRec {
  static all: FakeRec[] = [];
  static failStart = false;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  started = false;
  constructor() {
    FakeRec.all.push(this);
  }
  start() {
    if (FakeRec.failStart) throw new Error("InvalidStateError");
    this.started = true;
  }
  stop() {}
  final(text: string) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  }
}

function cbs() {
  const finals: string[] = [];
  const gaveUp = vi.fn();
  const cb: SttCallbacks = { onInterim: () => {}, onFinal: (u) => void finals.push(u.text), onStatus: () => {}, onGaveUp: gaveUp };
  return { cb, finals, gaveUp };
}

describe("Stt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRec.all = [];
    FakeRec.failStart = false;
    vi.stubGlobal("window", { SpeechRecognition: FakeRec, setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("Stop then Start: the old recognizer's late events don't spawn a second one", () => {
    const { cb, finals } = cbs();
    const stt = new Stt(cb);
    stt.start();
    const first = FakeRec.all[0]!;
    stt.stop();
    stt.start();
    first.final("late words from the old session");
    first.onend?.(); // arrives after the new one started
    vi.advanceTimersByTime(10_000);
    expect(FakeRec.all).toHaveLength(2);
    expect(finals).toEqual([]);
    FakeRec.all[1]!.final("hello there");
    expect(finals).toEqual(["hello there"]);
  });

  it("restarts after a normal end", () => {
    const { cb } = cbs();
    const stt = new Stt(cb);
    stt.start();
    FakeRec.all[0]!.onend?.();
    vi.advanceTimersByTime(200);
    expect(FakeRec.all).toHaveLength(2);
    expect(stt.isListening()).toBe(true);
  });

  it("retries when start() throws, then gives up instead of pretending to listen", () => {
    const { cb, gaveUp } = cbs();
    const stt = new Stt(cb);
    stt.start();
    FakeRec.failStart = true;
    FakeRec.all[0]!.onend?.();
    vi.advanceTimersByTime(60_000);
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(stt.isListening()).toBe(false);
  });
});
