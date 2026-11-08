// Pure helpers about the conversation: which lines the model sees, which
// lines look aimed at me, and the free-plan call limiter. No DOM.

import type { Utterance } from "./stt";

export const WINDOW_MS = 90_000; // the model sees the last 90 seconds…
export const MAX_LINES = 14; // …at most 14 lines of it

// The window the model sees: everything up to `upto` within 90 seconds of it.
export function windowEndingAt(transcript: Utterance[], upto: number): Utterance[] {
  const end = transcript[upto];
  if (!end) return [];
  return transcript
    .slice(0, upto + 1)
    .filter((u) => u.at >= end.at - WINDOW_MS)
    .slice(-MAX_LINES);
}

// Free providers are rate-limited, so only utterances that look aimed at me
// get an automatic call: my name, "you"/"your" (German: du, dir, dich, dein,
// Sie, Ihnen, euch), or a question mark. Fillers like "you know" or "thank
// you" don't count.
const FILLERS_EN = /\b(you know|thank you|thank you all|see you|you guys|if you will|mind you)\b/g;
const YOU_EN = /\b(you|your|yours)\b/;
const YOU_DE = /\b(du|dir|dich|dein\w*|euch|euer\w*|ihnen)\b|(^|[^.!?]\s)Sie\b/;

export function looksAimedAt(text: string, myName: string): boolean {
  const lower = text.toLowerCase();
  const name = myName.trim().toLowerCase();
  if (name !== "" && lower.includes(name)) return true;
  if (/\?\s*$/.test(text)) return true;
  return YOU_EN.test(lower.replace(FILLERS_EN, " ")) || YOU_DE.test(text.replace(/\bdanke\b/gi, " "));
}

export const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

// Calls in the last minute, for providers with a per-minute cap.
export class CallLimiter {
  private readonly times: number[] = [];
  readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  record(now = Date.now()): void {
    this.times.push(now);
  }

  // A call that never reached the provider (offline) doesn't count.
  unrecord(at: number): void {
    const i = this.times.lastIndexOf(at);
    if (i !== -1) this.times.splice(i, 1);
  }

  used(now = Date.now()): number {
    while (this.times.length && this.times[0]! <= now - 60_000) this.times.shift();
    return this.times.length;
  }

  left(now = Date.now()): number {
    return Math.max(0, this.perMinute - this.used(now));
  }
}
