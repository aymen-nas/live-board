// Early fire. The speech engine marks a sentence final only after a pause.
// When the live text is aimed at me and has stopped changing for 600 ms,
// answer it already; the final result then replaces the text and only asks
// again if it added 4 or more words.

import { wordCount } from "./conversation";
import { sameSentence } from "./match";

export const EARLY_MS = 600;
export const EARLY_MIN_WORDS = 5;
export const REASK_EXTRA_WORDS = 4;

export interface EarlyHooks {
  // Should this live text be answered early? (auto on, aimed at me, ≥5 words)
  wanted(text: string): boolean;
  // Is a call allowed right now? (free-plan limit)
  canCall(): boolean;
  // Add the live text as a transcript line, ask, and return the line's index.
  fire(text: string, at: number): number;
  // The final for that line arrived: replace its text; ask again if `reask`.
  settle(index: number, finalText: string, reask: boolean, gainedMs: number): void;
}

export class EarlyFire {
  private readonly hooks: EarlyHooks;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { index: number; text: string; firedAt: number } | null = null;

  constructor(hooks: EarlyHooks) {
    this.hooks = hooks;
  }

  // Every interim result. Starts or restarts the 600 ms stability timer.
  interim(text: string): void {
    this.cancelTimer();
    if (!text) return;
    // A new sentence started and the early one never got a final: it stays as heard.
    if (this.pending && !sameSentence(this.pending.text, text)) this.pending = null;
    if (this.pending || wordCount(text) < EARLY_MIN_WORDS || !this.hooks.wanted(text)) return;
    this.timer = setTimeout(() => this.fireNow(text), EARLY_MS);
  }

  // Every final result. Returns true when it belonged to the early-fired line,
  // which is then already in the transcript.
  final(text: string, at: number): boolean {
    this.cancelTimer();
    const p = this.pending;
    this.pending = null;
    if (!p || !sameSentence(p.text, text)) return false;
    const reask = wordCount(text) - wordCount(p.text) >= REASK_EXTRA_WORDS;
    this.hooks.settle(p.index, text, reask, at - p.firedAt);
    return true;
  }

  // New meeting or stop: forget the pending line (its index may no longer exist).
  reset(): void {
    this.cancelTimer();
    this.pending = null;
  }

  private fireNow(text: string): void {
    this.timer = null;
    if (this.pending || !this.hooks.canCall()) return;
    const at = Date.now();
    const index = this.hooks.fire(text, at);
    this.pending = { index, text, firedAt: at };
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
