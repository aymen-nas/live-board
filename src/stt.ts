// Streaming speech-to-text through the browser's SpeechRecognition API.
// On iPhone this is Safari's engine: partial text within ~0.5 s, final text
// when the speaker pauses. Safari stops the session on its own now and then,
// so we restart it for as long as `listening` is true.

export interface Utterance {
  text: string;
  at: number; // ms since epoch when the final result arrived
}

export interface SttCallbacks {
  onInterim: (text: string) => void;
  onFinal: (utterance: Utterance) => void;
  onStatus: (status: string) => void;
  onGaveUp: () => void; // mic permission denied or recognition unavailable
}

// Minimal typing; lib.dom doesn't ship these on every TS version.
type RecognitionCtor = new () => any;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function sttSupported(): boolean {
  return recognitionCtor() !== null;
}

const MAX_FAILURES = 5;

export class Stt {
  private rec: any = null;
  private closing: any = null; // stopped, may still deliver its last final
  private listening = false;
  private restartTimer: number | null = null;
  private failures = 0; // consecutive sessions that died with an error
  private readonly cb: SttCallbacks;
  private lang: string;

  constructor(cb: SttCallbacks, lang = "en-US") {
    this.cb = cb;
    this.lang = lang;
  }

  setLang(lang: string): void {
    this.lang = lang;
    if (this.listening) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.cb.onStatus("Speech recognition not available in this browser");
      this.cb.onGaveUp();
      return;
    }
    this.listening = true;
    this.failures = 0;
    this.closing = null; // a new session: the old one's late events no longer count
    this.spawn(Ctor);
  }

  stop(): void {
    this.listening = false;
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // stop(), not abort(): the engine still delivers the sentence in progress.
    this.closing = this.rec;
    try {
      this.rec?.stop();
    } catch {
      // already stopped
    }
    this.rec = null;
    this.cb.onStatus("Stopped");
  }

  isListening(): boolean {
    return this.listening;
  }

  private spawn(Ctor: RecognitionCtor): void {
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;

    // After Stop→Start or a language change, the old recognizer still fires
    // its last events; only the current one may touch state. After a plain
    // Stop, the stopped one may still hand over its last sentence.
    const current = () => this.rec === rec || (this.rec === null && this.closing === rec);
    const active = () => this.rec === rec; // status, errors and live text: the running one only
    let failed = false;

    rec.onstart = () => {
      if (active()) this.cb.onStatus("Listening");
    };

    rec.onresult = (event: any) => {
      if (!current()) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text: string = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const clean = text.trim();
          if (clean) this.cb.onFinal({ text: clean, at: Date.now() });
        } else {
          interim += text;
        }
      }
      if (active()) this.cb.onInterim(interim.trim());
    };

    rec.onerror = (event: any) => {
      if (!active()) return;
      // "no-speech" and "aborted" are routine on iOS; anything else is worth showing.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        failed = true;
        this.cb.onStatus(`Mic error: ${event.error}`);
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.listening = false;
        this.cb.onGaveUp();
      }
    };

    rec.onend = () => {
      if (!current()) return;
      if (this.closing === rec) this.closing = null;
      this.rec = null;
      if (this.listening) this.restartAfter(Ctor, failed);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.cb.onStatus(`Could not start mic: ${String(err)}`);
      if (this.listening) this.restartAfter(Ctor, true);
    }
  }

  // Safari ends sessions after silence or ~1 minute; restart quickly, but
  // back off when the last session died with an error, and give up after 5.
  private restartAfter(Ctor: RecognitionCtor, failed: boolean): void {
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= MAX_FAILURES) {
      // The speech service itself is unreachable; flickering won't fix it.
      this.listening = false;
      this.cb.onStatus(
        "Speech service unreachable. iPhone: Settings → General → Keyboard → Enable Dictation, and use a Safari tab. Laptop: Chrome or Safari only.",
      );
      this.cb.onGaveUp();
      return;
    }
    const delay = failed ? Math.min(500 * 2 ** this.failures, 5000) : 150;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.listening) this.spawn(Ctor);
    }, delay);
  }
}
