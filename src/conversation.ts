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

// Indexes of the lines heard in the last 90 seconds (for the tappable list).
export function recentIndexes(transcript: Utterance[], now: number): number[] {
  const out: number[] = [];
  transcript.forEach((u, i) => {
    if (u.at >= now - WINDOW_MS) out.push(i);
  });
  return out.slice(-MAX_LINES);
}

// Free providers are rate-limited, so only utterances that look aimed at me
// get an automatic call: my name, "you"/"your", or a question mark.
export function looksAimedAt(text: string, myName: string): boolean {
  const lower = text.toLowerCase();
  const name = myName.trim().toLowerCase();
  return (name !== "" && lower.includes(name)) || /\byou\b|\byour\b/.test(lower) || /\?\s*$/.test(text);
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

  used(now = Date.now()): number {
    while (this.times.length && this.times[0]! <= now - 60_000) this.times.shift();
    return this.times.length;
  }

  left(now = Date.now()): number {
    return Math.max(0, this.perMinute - this.used(now));
  }
}
