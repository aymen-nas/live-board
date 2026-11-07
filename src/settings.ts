// Settings saved on this phone (localStorage). Keys never leave the device
// except in the calls to the provider they belong to.

import { PROVIDERS, type Provider } from "./llm";

export interface Settings {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  myName: string;
  model: string;
  lang: string;
  boardText: string;
  boardName: string;
  auto: boolean;
  ghRepo: string;
  ghToken: string;
}

export const DEFAULTS: Settings = {
  provider: "routeway",
  baseUrl: PROVIDERS.routeway.baseUrl,
  apiKey: "",
  myName: "Aymen",
  model: PROVIDERS.routeway.model,
  lang: "en-US",
  boardText: "",
  boardName: "",
  auto: true,
  ghRepo: "aymen-nas/live-board-boards",
  ghToken: "",
};

const KEY = "live-board.settings";

type Store = Pick<Storage, "getItem" | "setItem">;

export function loadSettings(store: Store = localStorage): Settings {
  try {
    const raw = store.getItem(KEY);
    const s: Settings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    if (!(s.provider in PROVIDERS)) s.provider = DEFAULTS.provider;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings, store: Store = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode or storage blocked: the session still works, just not persisted
  }
}

// An Anthropic key always starts with "sk-ant-". Anything else sent to
// Anthropic fails as "invalid key", so move it to Routeway instead of
// making the user find the dropdown.
export function fixProviderForKey(s: Settings): void {
  if (s.provider === "anthropic" && s.apiKey && !s.apiKey.startsWith("sk-ant-")) {
    s.provider = "routeway";
    s.baseUrl = PROVIDERS.routeway.baseUrl;
    s.model = PROVIDERS.routeway.model;
  }
  if (s.provider !== "anthropic" && !s.baseUrl) s.baseUrl = PROVIDERS[s.provider].baseUrl;
  if (!s.model) s.model = PROVIDERS[s.provider].model;
}

// Pasted keys and tokens often carry a space or line break from the copy.
export const cleanSecret = (value: string): string => value.replace(/\s+/g, "");
