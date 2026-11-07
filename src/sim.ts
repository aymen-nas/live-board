// Simulation mode (?sim): a fake microphone that "speaks" a scripted meeting
// into the real app, word by word, so the whole flow (interim text, final
// utterance, auto-answer, streaming answer) can be tested without a mic.

import type { SttCallbacks } from "./stt";

export interface SimEvent {
  at: number;
  kind: "final" | "answer-start" | "answer" | "silent" | "error";
  text: string;
  ms?: number;
}

// Readable by automated tests: window.__simLog
export const simLog: SimEvent[] = [];
(window as any).__simLog = simLog;

export function simEnabled(): boolean {
  return new URLSearchParams(location.search).has("sim");
}

const WORD_MS = 120; // interim text grows by one word every 120 ms
const PAUSE_MS = 2500; // silence between utterances

export class SimStt {
  private listening = false;
  private timer: number | null = null;
  private readonly cb: SttCallbacks;
  private readonly lines: Promise<string[]>;

  constructor(cb: SttCallbacks) {
    this.cb = cb;
    this.lines = fetch(`${import.meta.env.BASE_URL}sim/transcript.txt`)
      .then((r) => r.text())
      .then((t) => t.split("\n").map((l) => l.trim()).filter(Boolean));
  }

  setLang(): void {}

  isListening(): boolean {
    return this.listening;
  }

  start(): void {
    this.listening = true;
    this.cb.onStatus("Listening (simulated)");
    void this.lines.then((lines) => this.play(lines, 0));
  }

  stop(): void {
    this.listening = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.cb.onStatus("Stopped");
  }

  private play(lines: string[], index: number): void {
    if (!this.listening) return;
    if (index >= lines.length) {
      this.cb.onStatus("Simulation finished");
      this.listening = false;
      this.cb.onGaveUp();
      return;
    }
    const words = lines[index]!.split(/\s+/);
    let shown = 0;
    const step = () => {
      if (!this.listening) return;
      shown++;
      if (shown < words.length) {
        this.cb.onInterim(words.slice(0, shown).join(" "));
        this.timer = window.setTimeout(step, WORD_MS);
      } else {
        const text = words.join(" ");
        simLog.push({ at: Date.now(), kind: "final", text });
        this.cb.onFinal({ text, at: Date.now() });
        this.timer = window.setTimeout(() => this.play(lines, index + 1), PAUSE_MS);
      }
    };
    step();
  }
}

export async function loadSimBoard(): Promise<string> {
  const r = await fetch(`${import.meta.env.BASE_URL}sim/board.txt`);
  return r.text();
}

// Dev only: the key comes from .env.local via Vite, never from the build.
export function devKey(): string {
  if (!import.meta.env.DEV) return "";
  return (import.meta.env.VITE_ROUTEWAY_API_KEY as string | undefined) ?? "";
}
