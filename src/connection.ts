// Warm connection. A cold call pays DNS, TCP and TLS before the request even
// leaves (a few round trips on mobile). Open the connection early and keep it
// open while listening with a tiny request that doesn't count as a model call.

import { preloadProvider } from "./llm";
import { settings } from "./state";

const PING_EVERY_MS = 45_000;
let timer: number | null = null;

function apiOrigin(): string | null {
  if (settings.provider === "anthropic") return "https://api.anthropic.com";
  try {
    return new URL(settings.baseUrl).origin;
  } catch {
    return null;
  }
}

export function preconnect(): void {
  preloadProvider(settings.provider);
  const origin = apiOrigin();
  if (!origin || document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.crossOrigin = "anonymous"; // same connection pool as the API calls (no cookies)
  document.head.append(link);
}

function ping(): void {
  const origin = apiOrigin();
  if (origin) fetch(`${origin}/`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
}

export function keepWarm(on: boolean): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  if (!on) return;
  ping();
  timer = window.setInterval(ping, PING_EVERY_MS);
}
