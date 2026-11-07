// Replays a transcript through the real pipeline, line by line, and prints
// what the app would have shown. Usage:
//   npx tsx scripts/replay.ts [board.txt] [transcript.txt] [--dry]
// Transcript lines starting with "[me] " are expected to get an answer; all
// other lines are expected to stay silent. The key comes from .env.local.

import { readFileSync, existsSync } from "node:fs";
import { answer } from "../src/llm";
import { buildSystemPrompt, parseBoard } from "../src/board";
import type { Utterance } from "../src/stt";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => !a.startsWith("--"));
const boardPath = files[0] ?? "scripts/sample-board.txt";
const transcriptPath = files[1] ?? "scripts/sample-transcript.txt";
const MODEL = "claude-haiku-5-5";
const WINDOW_MS = 90_000;
const GAP_MS = 4_000; // simulated spacing between utterances

function loadKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!existsSync(".env.local")) return "";
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\s]+)"?/);
    if (m) return m[1]!;
  }
  return "";
}

async function main(): Promise<void> {
  const board = parseBoard(readFileSync(boardPath, "utf8"));
  const systemPrompt = buildSystemPrompt(board, "Aymen");
  const lines = readFileSync(transcriptPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`board: ${board.cards.length} cards, ${board.questions.length} questions, ~${Math.round(systemPrompt.length / 4)} tokens`);
  console.log(`transcript: ${lines.length} lines, model ${MODEL}${dry ? ", DRY RUN" : ""}\n`);

  const apiKey = loadKey();
  if (!dry && !apiKey) {
    console.error("No ANTHROPIC_API_KEY in .env.local; run with --dry to skip the API.");
    process.exit(2);
  }

  const transcript: Utterance[] = [];
  let t = Date.now() - lines.length * GAP_MS;
  let correct = 0;
  let cacheHits = 0;
  const latencies: number[] = [];

  for (const [i, raw] of lines.entries()) {
    const expectAnswer = raw.startsWith("[me]");
    const text = raw.replace(/^\[me\]\s*/, "");
    t += GAP_MS;
    transcript.push({ text, at: t });
    const window_ = transcript.filter((u) => u.at >= t - WINDOW_MS).slice(-14);

    if (dry) {
      console.log(`${String(i + 1).padStart(2)} ${expectAnswer ? "ME " : "   "} ${text}`);
      continue;
    }

    const started = Date.now();
    let firstToken = 0;
    const result = await answer({
      apiKey,
      model: MODEL,
      systemPrompt,
      transcript: window_,
      forced: false,
      signal: new AbortController().signal,
      onFirstToken: () => {
        firstToken = Date.now() - started;
      },
      onDelta: () => {},
    });

    const ok = result.silent !== expectAnswer;
    if (ok) correct++;
    if (result.cacheRead > 0) cacheHits++;
    latencies.push(firstToken);
    const shown = result.silent ? "—" : result.text.replace(/\s+/g, " ");
    console.log(
      `${String(i + 1).padStart(2)} ${expectAnswer ? "ME " : "   "} ${ok ? "ok  " : "MISS"} ${String(firstToken).padStart(5)} ms  cache r${result.cacheRead}/w${result.cacheWrite}`,
    );
    console.log(`      said: ${text}`);
    console.log(`      app : ${shown}\n`);
  }

  if (!dry) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    console.log(`result: ${correct}/${lines.length} lines behaved as expected, cache hits ${cacheHits}/${lines.length}, first token p50 ${p50} ms, max ${max} ms`);
    if (correct < lines.length || cacheHits < lines.length - 1) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
