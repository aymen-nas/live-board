// Keeps the screen on while listening (iOS pauses the mic when it locks).

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

let lock: WakeLockSentinelLike | null = null;
let wanted = false;

export async function keepScreenOn(): Promise<void> {
  wanted = true;
  try {
    const wl = (navigator as { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }).wakeLock;
    lock = (await wl?.request("screen")) ?? null;
  } catch {
    // not supported or denied; the user keeps the screen on manually
  }
}

export function releaseScreen(): void {
  wanted = false;
  lock?.release().catch(() => {});
  lock = null;
}

// The lock is dropped when the app goes to the background; take it again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wanted) void keepScreenOn();
});
