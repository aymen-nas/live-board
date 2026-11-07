import Anthropic from "@anthropic-ai/sdk";
import type { Utterance } from "./stt";

export const MODELS = {
  fastest: "claude-haiku-5-5",
  balanced: "claude-sonnet-5-5",
  best: "claude-opus-5-5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export interface AnswerRequest {
  apiKey: string;
  model: ModelId;
  systemPrompt: string; // stable for the whole meeting -> cached
  transcript: Utterance[]; // recent window, oldest first
  forced: boolean; // true when the user tapped ANSWER
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onFirstToken: () => void;
}

export interface AnswerResult {
  text: string;
  silent: boolean; // model said nothing is aimed at me
  cacheRead: number;
  cacheWrite: number;
}

// The model sometimes decorates the marker ("—.", "- "); treat those as silence too.
const SILENT_RE = /^[\s\-–—.·]*$/;

let client: Anthropic | null = null;
let clientKey = "";

function getClient(apiKey: string): Anthropic {
  if (!client || clientKey !== apiKey) {
    // The key lives only on this phone; calls go straight to the API.
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    clientKey = apiKey;
  }
  return client;
}

export function formatTranscript(transcript: Utterance[]): string {
  if (transcript.length === 0) return "(nothing yet)";
  return transcript
    .map((u, i) => (i === transcript.length - 1 ? `LATEST: ${u.text}` : u.text))
    .join("\n");
}

export async function answer(req: AnswerRequest): Promise<AnswerResult> {
  const client = getClient(req.apiKey);

  const userText = req.forced
    ? `${formatTranscript(req.transcript)}\n\nANSWER: give me the exact words I say next.`
    : formatTranscript(req.transcript);

  const stream = client.messages.stream(
    {
      model: req.model,
      max_tokens: 200,
      // Thinking stays on (adaptive); low effort keeps the first token fast.
      output_config: { effort: "low" },
      system: [
        {
          type: "text",
          text: req.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userText }],
    },
    { signal: req.signal },
  );

  let text = "";
  let first = true;
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      if (first) {
        first = false;
        req.onFirstToken();
      }
      text += event.delta.text;
      // Don't flash the silence marker on screen while it streams.
      if (!SILENT_RE.test(text)) req.onDelta(text);
    }
  }

  const final = await stream.finalMessage();
  const usage = final.usage as { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  const clean = text.trim();
  return {
    text: clean,
    silent: SILENT_RE.test(clean),
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

// Pays the cache write once, right after the board is pasted, so the first
// real question doesn't carry it.
export async function warmCache(apiKey: string, model: ModelId, systemPrompt: string): Promise<void> {
  const client = getClient(apiKey);
  await client.messages.create({
    model,
    max_tokens: 1,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "warm" }],
  });
}
