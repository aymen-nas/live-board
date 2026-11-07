import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH=/live-board/ for GitHub Pages; "/" everywhere else.
// HTTPS=1 serves the dev server with a self-signed certificate, which the
// iPhone needs before Safari allows the microphone on a LAN address.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [
    ...(process.env.HTTPS ? [basicSsl()] : []),
    VitePWA({
      // "prompt": a new version waits until the user taps "Update ready" (src/update.ts).
      registerType: "prompt",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Live Board",
        short_name: "Live Board",
        description: "Live meeting board: the exact words to say next.",
        display: "standalone",
        background_color: "#0b0d10",
        theme_color: "#0b0d10",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        // Only the app shell is cached; API calls always go to the network.
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: { host: true },
});
