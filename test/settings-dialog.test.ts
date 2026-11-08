// @vitest-environment happy-dom
// The settings sheet against a fake GitHub: "Use" must load the board.

import { beforeAll, describe, expect, it, vi } from "vitest";

const BOARD = "CLUELY PRIMER\nAlways answer in English.\n══════════\nBUDGET\nThe budget is 40k for next quarter.";

vi.mock("../src/github", () => ({
  listRemoteBoards: async () => ({ boards: [{ name: "2026-11-08 Weekly sync", path: "boards/2026-11-08 Weekly sync.txt" }], broadToken: false }),
  fetchRemoteBoard: async () => BOARD,
}));
vi.mock("../src/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm")>()),
  preloadProvider: () => {},
  warmCache: async () => {},
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  // happy-dom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

describe("settings sheet", () => {
  it("Use loads the picked board and keeps a key typed in the same visit", async () => {
    const st = await import("../src/state");
    const { initSettings, openSettings } = await import("../src/settingsDialog");
    st.settings.ghToken = "github_pat_test";
    st.settings.apiKey = "";
    initSettings();
    openSettings();
    await tick();
    await tick();
    (document.getElementById("apiKey") as HTMLInputElement).value = "sk-ant-typed";
    (document.getElementById("remoteLoad") as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(st.state.board?.cards.map((c) => c.title)).toContain("BUDGET");
    expect(st.state.systemPrompt).toContain("40k");
    expect(st.settings.boardName).toBe("2026-11-08 Weekly sync");
    expect(st.settings.apiKey).toBe("sk-ant-typed");
    expect(document.getElementById("answer")!.textContent).toContain("Weekly sync loaded");
  });
});
