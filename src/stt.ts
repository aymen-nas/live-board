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

export class Stt {
  private rec: any = null;
  private listening = false;
  private restartTimer: number | null = null;
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
      return;
    }
    this.listening = true;
    this.spawn(Ctor);
  }

  stop(): void {
    this.listening = false;
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
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

    rec.onstart = () => this.cb.onStatus("Listening");

    rec.onresult = (event: any) => {
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
      this.cb.onInterim(interim.trim());
    };

    rec.onerror = (event: any) => {
      // "no-speech" and "aborted" are routine on iOS; anything else is worth showing.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        this.cb.onStatus(`Mic error: ${event.error}`);
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.listening = false;
      }
    };

    rec.onend = () => {
      this.rec = null;
      if (!this.listening) return;
      // Safari ends sessions after silence or ~1 minute; restart quickly.
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = null;
        if (this.listening) this.spawn(Ctor);
      }, 150);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.cb.onStatus(`Could not start mic: ${String(err)}`);
    }
  }
}
