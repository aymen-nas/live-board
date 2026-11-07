import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// BASE_PATH=/live-board/ for GitHub Pages; "/" everywhere else.
// HTTPS=1 serves the dev server with a self-signed certificate, which the
// iPhone needs before Safari allows the microphone on a LAN address.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: { host: true },
});
