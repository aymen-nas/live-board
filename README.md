# Live Board

A personal live-meeting assistant for the phone. Load a meeting board (the
same format as the Cluely boards: an opener, cards separated by `══════════`,
a question bank), start listening, and the app shows the exact words to say
whenever something in the room is aimed at you.

**Live app:** https://aymen-nas.github.io/live-board/

How it works: the phone's built-in speech recognition streams the
transcript. Each finished line, plus the last 90 seconds, goes to the chosen
provider (Routeway's free Gemma by default, or Claude) with the board as the
system prompt. The answer streams back in 1 to 3 sentences; when nothing is
aimed at you the model stays silent. Nothing personal is in this repo or on
the server: keys, boards and the meeting live only in the phone's storage.

## On the iPhone

1. Open https://aymen-nas.github.io/live-board/ in Safari or Brave.
2. Share → **Add to Home Screen**. It opens full screen with its own icon.
3. ⚙︎ Settings. On first run the app shows 2 steps: add the API key under
   **Provider, key and language**, then pick a board. Return on the keyboard
   saves.
4. **Start**, allow the microphone, keep the screen on. The red dot means
   listening. The blue italic line is live speech, the big text is what to
   say, and a sliding bar above it means an answer is on its way. Errors show
   in red with the provider's message.
5. **Answer** forces an answer on the last line; tap any line in the list to
   answer that one. **Question** cycles the question bank. The 📌 chip opens
   the matching board card as a sheet, and the 💡 chip suggests a question
   after a quiet minute. Untick **auto** to answer only on tap. ⧉ copies the
   transcript with the suggested answers.

**Updates.** A new version downloads in the background. When you're not
listening, an **Update ready · tap** pill appears; tapping it reloads into the
new version. The meeting (transcript and answers) survives the reload: it is
restored if the app opens again within 30 minutes of the last line, and
deleted after that. ⚙︎ → **New meeting** clears it at once. After the
8 Nov 2026 update that added the pill, close the app once from the app
switcher; older versions can't show it.

## Boards from Claude Code (no copy-paste)

Claude Code writes every meeting board to a private repository,
`aymen-nas/live-board-boards`, as `boards/YYYY-MM-DD Meeting name.txt`. The
app lists them under ⚙︎ → **Boards from Claude**: pick one, tap **Use**.
A copy is kept on the phone for offline use.

One-time setup on the phone: create a fine-grained GitHub token at
https://github.com/settings/personal-access-tokens/new with
- Repository access: only `live-board-boards`
- Permissions: Repository → Contents → Read-only

then paste it under ⚙︎ → Provider, key and language → GitHub token, and tap ↻.
A classic token works too, but the app warns that it can do far more than read.

## Providers

| Provider | Cost | Speed | Notes |
|---|---|---|---|
| Anthropic, Haiku 5.5 | about 2 cents per meeting, 5 $ minimum top-up | not measured yet (no key here) | inputs not used for training; the board is cached; answers every line |
| Routeway, `:free` models | 0 $ | first word in 1–5 s, shared queue | 5 calls a minute, 200 a day; Routeway and the model host see the board and transcript |
| Gemini free tier | 0 $ | not measured | on the free tier Google may use what you send to improve its products |
| Custom | — | — | any OpenAI-style `/chat/completions` endpoint that allows browser calls |

A key is matched to its provider by prefix (`sk-ant-` Anthropic, `AIza`
Gemini), so an Anthropic key is never sent to another host. Only Anthropic
answers every line automatically. The others answer only lines that look
aimed at you: your name, "you"/"your" without fillers like "you know", German
address (du, dir, Sie…), or a question. Routeway is also capped at 5 calls a
minute, shown in the header. **Answer** and tapping a line always work.

**Speed.** When a line aimed at you has stopped changing for 600 ms, the app
answers it before the speech engine marks it final. The final text then
replaces it, and the app asks again only if it added 4 or more words. The top
line shows the gain, e.g. `900 ms · 600 ms early`. Calls run side by side, so
a later line can't cancel an answer that is streaming. The connection to the
provider opens when the app loads and stays warm while listening, and the
Anthropic SDK (380 KB) is parsed only when Anthropic is the provider (the
service worker still downloads it once per version). Sending only
the matching cards made no difference on the free Gemma model (8 calls, 7.7k
vs 3k tokens: the wait is Routeway's queue), so the whole board is sent.

## Develop

```bash
npm install
npm run dev         # https://localhost:5173 (self-signed)
npm run dev:phone   # same, open to the LAN for the iPhone: https://<laptop-ip>:5173
npm run dev:http    # plain HTTP on localhost
npm run typecheck   # src, tests, scripts, vite config
npm test            # unit tests
```

`dev:phone` exposes the dev server to the local network, including
`VITE_` variables from `.env.local`, so use it only on a trusted network.

Code map: `main.ts` wires the pieces; `ui.ts` (markup, display helpers),
`state.ts` (settings and meeting state), `view.ts` (rendering, board loading),
`listening.ts` (speech → transcript → when to ask), `early.ts` (early fire),
`answering.ts` (streamed calls, tested with a fake model), `llm.ts` (providers), `connection.ts`
(keep-warm), `settingsDialog.ts`, `meeting.ts` (survives reloads),
`update.ts` (update prompt), `stt.ts` (speech recognition), `board.ts`,
`match.ts`, `conversation.ts` (pure helpers).

Replay a transcript through the real pipeline. Keys come from `.env.local`
(gitignored): `ANTHROPIC_API_KEY`, `ROUTEWAY_API_KEY` or `GEMINI_API_KEY`.

```bash
npm run replay -- --dry                                     # no API: show the lines
npm run replay -- --provider routeway --pace 12500          # free plan: 5 calls a minute
npx tsx scripts/replay.ts my-board.txt my-transcript.txt --provider gemini --model gemini-3.5-flash-lite
```

Transcript lines starting with `[me] ` are expected to get an answer; the
rest should stay silent. The harness prints per line the answer, the time to
first token and the cache read/write tokens, and exits non-zero if the model
misbehaves or the cache isn't hit from the second call on.

Simulation mode: open the app with `?sim` (for example
https://localhost:5173/?sim, or http://localhost:5173/?sim with `dev:http`) and press Start. A fake microphone "speaks"
`public/sim/transcript.txt` word by word into the real app with the sample
board, waiting 1.2 s before each final like a real engine. In dev the key
comes from `VITE_ROUTEWAY_API_KEY` in `.env.local`; it never reaches the
production build, and `?sim` never saves settings. Results are in
`window.__simLog`. Last run (8 Nov): 3 of 3 lines aimed at you answered, each
fired 600 ms before the final, first word after 3.3–5 s on the free queue;
silent on the other 9; no console errors.

The update prompt can't be tested in the Claude browser pane (it blocks
service workers). It was tested in headless Chromium: install build A,
deploy build B, the pill appears, a tap loads B.

Pushes to `main` typecheck, test, build and deploy to GitHub Pages.

## Known limits

- Speech recognition works in any browser on the iPhone (they all run on
  Apple's engine; tested in Brave). On a desktop it needs Google Chrome or
  Safari: Brave desktop and Firefox fail with "network". It can't be tested in
  the Claude desktop browser pane, which blocks microphones; use `?sim`.
- Safari stops a recognition session now and then; the app restarts it within
  about 150 ms, so a word can be lost at the seam.
- The app must stay in the foreground with the screen on; iOS pauses the mic
  otherwise. A wake lock keeps the screen on while listening.
- Calls go straight from the browser with your key; they fail on networks
  that block the provider.
- Transcription quality on product names and codes depends on Apple's engine;
  the board tells the model to read through garbled names.
- Every GitHub Pages site of the `aymen-nas` account shares this app's
  storage (keys, token, boards, the saved meeting). Don't publish another repo of this account
  to Pages; if that's ever needed, move the app to its own domain.
