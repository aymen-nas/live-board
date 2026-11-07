# Live Board

A personal live-meeting assistant for the phone. Paste a meeting board (the
same format as the Cluely boards: an opener, cards separated by `══════════`,
a question bank), start listening, and the app shows the exact words to say
whenever something in the room is aimed at you.

**Live app:** https://aymen-nas.github.io/live-board/

How it works: Safari's built-in speech recognition streams the transcript;
each finished utterance goes to Claude together with the last 90 seconds of
transcript and the board as a cached system prompt; the answer streams back
in 1 to 3 sentences. When nothing is aimed at you the model stays silent.
Nothing personal is in this repo or on the server: the key and the board live
only in the phone's local storage.

## On the iPhone

1. Open https://aymen-nas.github.io/live-board/ in Safari.
2. Share → **Add to Home Screen**. It opens full screen with its own icon.
3. ⚙︎ Settings: Anthropic API key, your name, model (Haiku 5.5 is the fastest),
   language, and the board text. Save. It parses the board and pre-warms the
   prompt cache.
4. **Start**, allow the microphone, put the phone on the table with the screen
   on. The italic line is live speech; the big text is what to say; the header
   shows the time from the end of the question to the first word.
5. **Answer** forces an answer on the last thing said. **Question** cycles the
   question bank. Untick **auto** to answer only on tap.

## Develop

```bash
npm install
npm run dev        # HTTPS on https://<laptop-ip>:5173 (self-signed; accept it once on the phone)
npm run dev:http   # plain HTTP for desktop browsers
npm test           # board parser tests
```

Replay a transcript through the real pipeline (needs `ANTHROPIC_API_KEY` in
`.env.local`, which is gitignored):

```bash
npm run replay                              # scripts/sample-board.txt + scripts/sample-transcript.txt
npx tsx scripts/replay.ts my-board.txt my-transcript.txt
```

Transcript lines starting with `[me] ` are expected to get an answer; the
rest should stay silent. The harness prints per line the answer, the time to
first token and the cache read/write tokens, and exits non-zero if the model
misbehaves or the cache isn't hit from the second call on.

Pushes to `main` build, test and deploy to GitHub Pages.

## Known limits

- Speech recognition needs Safari (or Chrome on desktop); it can't be tested in
  the Claude desktop browser pane, which blocks microphones.
- Safari stops a recognition session now and then; the app restarts it within
  about 150 ms, so a word can be lost at the seam.
- The app must stay in the foreground with the screen on; iOS pauses the mic
  otherwise. A wake lock keeps the screen on while listening.
- Calls to the Claude API go straight from the browser with your key; they
  fail on networks that block `api.anthropic.com`.
- Transcription quality on product names (HeRO, SHARP, ISINs) depends on
  Apple's engine; the board tells the model to read through garbled names.
