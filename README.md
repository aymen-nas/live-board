# Live Board

A personal live-meeting assistant for the phone. Paste a meeting board (the
same format as the Cluely boards: an opener, cards separated by `══════════`,
a question bank), start listening, and the app shows the exact words to say
whenever something in the room is aimed at you.

How it works: Safari's built-in speech recognition streams the transcript;
each finished utterance goes to Claude together with the last 90 seconds of
transcript and the board as a cached system prompt; the answer streams back
in 1 to 3 sentences. When nothing is aimed at you the model stays silent.

## Run it on the iPhone (same Wi-Fi)

```bash
HTTPS=1 npm run dev
```

Open the `https://<laptop-ip>:5173` address in Safari on the phone, accept the
self-signed certificate once, add the page to the home screen if you like.
Settings (⚙︎): Anthropic API key, your name, model, language, board.

## Build for hosting

```bash
BASE_PATH=/live-board/ npm run build   # static files in dist/
```

Nothing secret is in the code: the key and the board live only in the
phone's local storage.
