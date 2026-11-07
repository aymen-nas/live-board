// Type only: the SDK itself (~300 KB) loads on demand, so the free-provider
// path never downloads it.
import type Anthropic from "@anthropic-ai/sdk";
import type { Utterance } from "./stt";

export type Provider = "anthropic" | "routeway" | "gemini" | "custom";

export interface ProviderInfo {
  label: string;
  baseUrl: string; // OpenAI-style base, empty for Anthropic
  model: string; // default model
  note: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "",
    model: "claude-haiku-5-5",
    note: "Paid, about 2 cents per meeting. Inputs are not used for training.",
  },
  routeway: {
    label: "Routeway (free models)",
    baseUrl: "https://api.routeway.ai/v1",
    model: "gemma-4-26b-a4b-it-luminous:free",
    note: "Models ending in :free cost nothing; 5 calls a minute and 200 a day on the free plan. Shared queue: the first word takes 1 to 5 seconds. The DeepSeek and MiniMax free models often time out.",
  },
  gemini: {
    label: "Google Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash-lite",
    note: "Free, but on the free tier Google may use what you send to improve its products.",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    model: "",
    note: "Any provider with an OpenAI-style /chat/completions endpoint. It must allow calls from a browser.",
  },
};

export interface AnswerRequest {
  provider: Provider;
  baseUrl: string; // ignored for anthropic
  apiKey: string;
  model: string;
  systemPrompt: string; // stable for the whole meeting -> cached where the provider supports it
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

let sdk: Promise<typeof import("@anthropic-ai/sdk")> | null = null;

// Starts downloading the SDK ahead of the first call (no-op for other providers).
export function preloadProvider(provider: Provider): void {
  if (provider === "anthropic") sdk ??= import("@anthropic-ai/sdk");
}

async function getClient(apiKey: string): Promise<Anthropic> {
  if (!client || clientKey !== apiKey) {
    sdk ??= import("@anthropic-ai/sdk");
    const { default: AnthropicClient } = await sdk;
    // The key lives only on this phone; calls go straight to the API.
    client = new AnthropicClient({ apiKey, dangerouslyAllowBrowser: true });
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

function userText(req: AnswerRequest): string {
  return req.forced
    ? `${formatTranscript(req.transcript)}\n\nANSWER: give me the exact words I say next about the LATEST line, even if it wasn't aimed at me. Never reply with — here.`
    : formatTranscript(req.transcript);
}

function finish(text: string, cacheRead = 0, cacheWrite = 0): AnswerResult {
  const clean = text.trim();
  return { text: clean, silent: SILENT_RE.test(clean), cacheRead, cacheWrite };
}

export async function answer(req: AnswerRequest): Promise<AnswerResult> {
  return req.provider === "anthropic" ? answerAnthropic(req) : answerOpenAiCompatible(req);
}

async function answerAnthropic(req: AnswerRequest): Promise<AnswerResult> {
  const client = await getClient(req.apiKey);
  const stream = client.messages.stream(
    {
      model: req.model,
      max_tokens: 200,
      // Thinking stays on (adaptive); low effort keeps the first token fast.
      output_config: { effort: "low" },
      system: [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText(req) }],
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
  return finish(text, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0);
}

// Streams an OpenAI-style chat completion (Routeway, Gemini's compatibility
// endpoint, DeepSeek, Groq, …). Server-sent events: "data: {...}" lines,
// then "data: [DONE]".
async function answerOpenAiCompatible(req: AnswerRequest): Promise<AnswerResult> {
  const base = req.baseUrl.replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    max_tokens: 200,
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content: userText(req) },
    ],
  };
  // Gemini maps this to its thinking level. Don't send it to Routeway: there it
  // switches Gemma into a thinking mode that spends the whole budget on reasoning.
  if (req.provider === "gemini") body.reasoning_effort = "low";

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let first = true;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // partial or keep-alive line
      }
      if (parsed?.error) throw new Error(parsed.error.message ?? "provider error");
      const delta: string = parsed?.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      if (first) {
        first = false;
        req.onFirstToken();
      }
      text += delta;
      if (!SILENT_RE.test(text)) req.onDelta(text);
    }
  }
  return finish(text);
}

// Pays Anthropic's cache write once, right after the board is pasted, so the
// first real question doesn't carry it. Other providers cache on their own.
export async function warmCache(provider: Provider, apiKey: string, model: string, systemPrompt: string): Promise<void> {
  if (provider !== "anthropic") return;
  const client = await getClient(apiKey);
  await client.messages.create({
    model,
    max_tokens: 1,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "warm" }],
  });
}
