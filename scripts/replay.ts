// Replays a transcript through the real pipeline, line by line, and prints
// what the app would have shown. Usage:
//   npx tsx scripts/replay.ts [board.txt] [transcript.txt] [--dry] [--provider anthropic|routeway|gemini] [--model id] [--pace ms]
// Transcript lines starting with "[me] " are expected to get an answer; all
// other lines are expected to stay silent. Keys come from .env.local:
// ANTHROPIC_API_KEY, ROUTEWAY_API_KEY, GEMINI_API_KEY.

import { readFileSync, existsSync } from "node:fs";
import { PROVIDERS, answer, type Provider } from "../src/llm";
import { buildSystemPrompt, parseBoard } from "../src/board";
import type { Utterance } from "../src/stt";
import { windowEndingAt } from "../src/conversation";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const provider = (opt("provider") ?? "anthropic") as Provider;
const MODEL = opt("model") ?? PROVIDERS[provider].model;
const files = args.filter((a, i) => !a.startsWith("--") && !["--provider", "--model", "--pace"].includes(args[i - 1] ?? ""));
const boardPath = files[0] ?? "scripts/sample-board.txt";
const transcriptPath = files[1] ?? "scripts/sample-transcript.txt";
const KEY_VAR: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  routeway: "ROUTEWAY_API_KEY",
  gemini: "GEMINI_API_KEY",
  custom: "CUSTOM_API_KEY",
};
const PACE_MS = Number(opt("pace") ?? 0); // wait between calls, for rate-limited free plans
const GAP_MS = 4_000; // simulated spacing between utterances

function loadKey(): string {
  const name = KEY_VAR[provider];
  if (process.env[name]) return process.env[name]!;
  if (!existsSync(".env.local")) return "";
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s]+)"?`));
    if (m) return m[1]!;
  }
  return "";
}

// Free plans answer 429 when a burst hits the per-minute cap; wait and retry.
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt >= tries || !/429/.test(String(err?.message))) throw err;
      process.stdout.write("   (rate limited, waiting 20 s)\n");
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}

async function main(): Promise<void> {
  const board = parseBoard(readFileSync(boardPath, "utf8"));
  const systemPrompt = buildSystemPrompt(board, "Aymen");
  const lines = readFileSync(transcriptPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`board: ${board.cards.length} cards, ${board.questions.length} questions, ~${Math.round(systemPrompt.length / 4)} tokens`);
  console.log(`transcript: ${lines.length} lines, provider ${provider}, model ${MODEL}${dry ? ", DRY RUN" : ""}\n`);

  const apiKey = loadKey();
  if (!dry && !apiKey) {
    console.error(`No ${KEY_VAR[provider]} in .env.local; run with --dry to skip the API.`);
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
    const window_ = windowEndingAt(transcript, transcript.length - 1);

    if (dry) {
      console.log(`${String(i + 1).padStart(2)} ${expectAnswer ? "ME " : "   "} ${text}`);
      continue;
    }

    if (PACE_MS > 0 && i > 0) await new Promise((r) => setTimeout(r, PACE_MS));
    const started = Date.now();
    let firstToken = 0;
    const result = await withRetry(() => answer({
      provider,
      baseUrl: PROVIDERS[provider].baseUrl,
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
    }));

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
    const cacheNote = provider === "anthropic" ? `, cache hits ${cacheHits}/${lines.length}` : "";
    console.log(`result: ${correct}/${lines.length} lines behaved as expected${cacheNote}, first token p50 ${p50} ms, max ${max} ms`);
    if (correct < lines.length || (provider === "anthropic" && cacheHits < lines.length - 1)) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
