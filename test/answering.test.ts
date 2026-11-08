// @vitest-environment happy-dom
// The answer flow with a fake model: overlapping calls, errors on later
// lines, re-asks, taps. Each case is a scenario a reviewer reproduced.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerRequest, AnswerResult } from "../src/llm";

// A controllable model: each call waits until the test resolves or rejects it.
interface Pending {
  req: AnswerRequest;
  stream(text: string): void;
  finish(text: string): void;
  fail(err: Error): void;
}
const calls: Pending[] = [];

vi.mock("../src/llm", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/llm")>();
  return {
    ...real,
    preloadProvider: () => {},
    answer: (req: AnswerRequest) =>
      new Promise<AnswerResult>((resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        calls.push({
          req,
          stream: (text) => req.onDelta(text),
          finish: (text) => {
            const clean = text.trim();
            resolve({ text: clean, silent: /^[\s\-–—.·]*$/.test(clean), cacheRead: 0, cacheWrite: 0 });
          },
          fail: (err) => reject(err),
        });
      }),
  };
});

type Answering = typeof import("../src/answering");
type State = typeof import("../src/state");
let ask: Answering["ask"];
let cancelAll: Answering["cancelAll"];
let st: State;
const tick = () => new Promise((r) => setTimeout(r, 0));
const screen = () => document.getElementById("answer")!;
const history = () => [...document.querySelectorAll("#history div")].map((d) => d.textContent);
const meta = () => document.getElementById("meta")!.textContent;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  ({ ask, cancelAll } = await import("../src/answering"));
  st = await import("../src/state");
});

beforeEach(() => {
  cancelAll();
  calls.length = 0;
  st.settings.provider = "anthropic"; // no free-plan cap in these tests
  st.settings.apiKey = "sk-ant-test";
  st.state.systemPrompt = "board";
  st.state.transcript.length = 0;
  st.state.answers.length = 0;
  st.state.session.length = 0;
  st.state.screen = { kind: "notice" };
  const now = Date.now();
  for (let i = 0; i < 4; i++) st.state.transcript.push({ text: `line ${i}`, at: now - (4 - i) * 1000 });
  screen().textContent = "";
  document.getElementById("meta")!.textContent = "";
});

describe("answer flow", () => {
  it("an error on a later auto call doesn't replace the answer that is streaming", async () => {
    void ask(false, 0);
    void ask(false, 1);
    calls[0]!.stream("We are at 25 euros");
    calls[1]!.fail(Object.assign(new Error("Overloaded"), { status: 529 }));
    await tick();
    expect(screen().textContent).toBe("We are at 25 euros");
    expect(meta()).toContain("Overloaded");
    calls[0]!.finish("We are at 25 euros a month.");
    await tick();
    expect(screen().textContent).toBe("We are at 25 euros a month.");
    expect(screen().classList.contains("error")).toBe(false);
  });

  it("a silent later call doesn't cancel an answer that is streaming", async () => {
    void ask(false, 0);
    void ask(false, 1);
    calls[0]!.stream("The test runs");
    calls[1]!.finish("—");
    calls[0]!.finish("The test runs since yesterday.");
    await tick();
    expect(screen().textContent).toBe("The test runs since yesterday.");
    expect(st.state.answers.map((a) => a.text)).toEqual(["The test runs since yesterday."]);
  });

  it("a re-ask that comes back silent puts the last full answer back, not the cut-off one", async () => {
    void ask(false, 0);
    calls[0]!.finish("Earlier full answer.");
    await tick();
    void ask(false, 2); // early fire on line 2
    calls[1]!.stream("Yes, the cost is about");
    void ask(false, 2); // the final added words: re-ask the same line
    calls[2]!.finish("—");
    await tick();
    expect(screen().textContent).toBe("Earlier full answer.");
    expect(screen().classList.contains("muted")).toBe(true);
  });

  it("a re-ask of the same line never cancels a tap", async () => {
    void ask(true, 2);
    void ask(false, 2);
    expect(calls[0]!.req.signal.aborted).toBe(false);
    expect(calls[0]!.req.forced).toBe(true);
  });

  it("a tap that gets silence keeps the last answer and says so", async () => {
    void ask(false, 0);
    calls[0]!.finish("Keep me.");
    await tick();
    void ask(true, 3);
    calls[1]!.finish("—");
    await tick();
    expect(screen().textContent).toBe("Keep me.");
    expect(meta()).toBe("Nothing to say on that line.");
  });

  it("an answer that finishes late goes to the history in call order", async () => {
    void ask(false, 0); // A
    void ask(false, 1); // B
    calls[1]!.stream("B answer");
    calls[1]!.finish("B answer.");
    await tick();
    calls[0]!.finish("A answer.");
    await tick();
    expect(screen().textContent).toBe("B answer.");
    expect(st.state.answers.map((a) => a.text)).toEqual(["A answer.", "B answer."]);
    expect(history()).toEqual(["A answer."]);
  });

  it("a tap's error is shown on the answer area", async () => {
    void ask(true, 3);
    calls[0]!.fail(Object.assign(new Error("Invalid API key"), { status: 401 }));
    await tick();
    expect(screen().textContent).toContain("Key rejected by the provider");
    expect(screen().classList.contains("error")).toBe(true);
  });

  it("an auto answer that fails mid-stream gives the screen back to the last full answer", async () => {
    void ask(false, 0);
    calls[0]!.finish("Earlier full answer.");
    await tick();
    void ask(false, 1);
    calls[1]!.stream("Yes, the cost is about");
    calls[1]!.fail(Object.assign(new Error("Overloaded"), { status: 529 }));
    await tick();
    expect(screen().textContent).toBe("Earlier full answer.");
    expect(screen().classList.contains("muted")).toBe(true);
    expect(meta()).toContain("Overloaded");
  });

  it("an auto re-ask of a line I tapped doesn't start a second call", async () => {
    void ask(true, 2);
    void ask(false, 2);
    expect(calls).toHaveLength(1);
    calls[0]!.stream("Tapped answer");
    calls[0]!.finish("Tapped answer.");
    await tick();
    expect(screen().textContent).toBe("Tapped answer.");
  });

  it("a tap's late error doesn't cover a newer answer", async () => {
    void ask(true, 1);
    void ask(false, 3);
    calls[1]!.stream("Newer answer");
    calls[0]!.fail(Object.assign(new Error("timeout"), { status: 504 }));
    await tick();
    expect(screen().textContent).toBe("Newer answer");
    calls[1]!.finish("Newer answer.");
    await tick();
    expect(history()).toEqual([]);
    expect(screen().textContent).toBe("Newer answer.");
  });

  it("with no answers yet, a cut-off stream doesn't block an older call from drawing", async () => {
    void ask(false, 0); // A, still waiting
    void ask(false, 2); // early fire
    calls[1]!.stream("Half an");
    void ask(false, 2); // re-ask
    calls[2]!.finish("—");
    await tick();
    expect(screen().textContent).toBe("");
    calls[0]!.finish("A answer.");
    await tick();
    expect(screen().textContent).toBe("A answer.");
  });

  it("after a notice mid-stream, the stream takes the screen back and an older answer can't overwrite it", async () => {
    const { showNotice } = await import("../src/view");
    void ask(false, 0); // A, older
    void ask(false, 1); // B
    calls[1]!.stream("B partial");
    showNotice("A suggested question?", false);
    calls[1]!.stream("B full answer");
    calls[1]!.finish("B full answer.");
    await tick();
    expect(screen().textContent).toBe("B full answer.");
    expect(history()).not.toContain("B full answer.");
    calls[0]!.finish("A older answer.");
    await tick();
    expect(screen().textContent).toBe("B full answer.");
    expect(history()).toContain("A older answer.");
  });

  it("an overtaken call that fails doesn't dim the current answer", async () => {
    void ask(false, 0); // A
    void ask(false, 1); // B
    calls[0]!.stream("A partial");
    calls[1]!.stream("B partial");
    calls[1]!.finish("B full.");
    await tick();
    calls[0]!.fail(Object.assign(new Error("Overloaded"), { status: 529 }));
    await tick();
    expect(screen().textContent).toBe("B full.");
    expect(screen().classList.contains("muted")).toBe(false);
  });

  it("a notice opened while a re-ask is pending isn't overwritten when the re-ask stays silent", async () => {
    const { showNotice } = await import("../src/view");
    void ask(false, 0);
    calls[0]!.finish("Earlier full answer.");
    await tick();
    void ask(false, 2);
    calls[1]!.stream("Half a");
    void ask(false, 2); // re-ask aborts the early call
    await tick();
    showNotice("Is a chat ping still what you want?", false);
    calls[2]!.finish("—");
    await tick();
    expect(screen().textContent).toBe("Is a chat ping still what you want?");
  });

  it("a silent tap doesn't dim a newer answer", async () => {
    void ask(true, 1); // tap
    void ask(false, 3); // newer auto
    calls[1]!.stream("Newer");
    calls[1]!.finish("Newer full.");
    await tick();
    calls[0]!.finish("—");
    await tick();
    expect(screen().textContent).toBe("Newer full.");
    expect(screen().classList.contains("muted")).toBe(false);
  });

  it("a re-ask keeps the cut-off text until it draws: no flash of the old answer, no older call sneaking in", async () => {
    void ask(false, 0);
    calls[0]!.finish("Earlier full answer.");
    await tick();
    void ask(false, 1); // A, older line, still waiting
    void ask(false, 2); // early fire
    calls[2]!.stream("Yes, the cost is about");
    void ask(false, 2); // re-ask
    await tick();
    expect(screen().textContent).toBe("Yes, the cost is about");
    calls[1]!.finish("Answer for line one.");
    await tick();
    expect(screen().textContent).toBe("Yes, the cost is about");
    expect(history()).toContain("Answer for line one.");
    calls[3]!.stream("Yes, the cost is about 40k");
    calls[3]!.finish("Yes, the cost is about 40k a quarter.");
    await tick();
    expect(screen().textContent).toBe("Yes, the cost is about 40k a quarter.");
  });

  it("a question I asked for stays as a chip when an answer takes the screen", async () => {
    const { showQuestion } = await import("../src/view");
    void ask(false, 1);
    calls[0]!.stream("Part one");
    showQuestion("Is a chat ping still what you want?");
    calls[0]!.stream("Part one, part two");
    await tick();
    expect(screen().textContent).toBe("Part one, part two");
    expect(document.querySelector("#chips [data-chip=question]")?.textContent).toContain("Is a chat ping");
  });
});
