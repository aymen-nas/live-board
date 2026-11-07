// New versions: the service worker downloads them in the background, then the
// app shows "Update ready" and reloads only when tapped, never mid-meeting.
// iOS rarely checks for updates by itself, so check whenever the app comes
// back to the front, and every 30 minutes while it's open.

import { registerSW } from "virtual:pwa-register";

const CHECK_EVERY_MS = 30 * 60_000;

export function setupUpdates(onReady: (reload: () => void) => void): void {
  if (import.meta.env.DEV || !("serviceWorker" in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => onReady(() => void updateSW(true)),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      const check = () => {
        if (navigator.onLine) registration.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, CHECK_EVERY_MS);
    },
  });
}
