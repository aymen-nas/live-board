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

// Which provider a key belongs to, when its prefix says so.
export function providerForKey(key: string): Provider | null {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("sk-")) return "routeway";
  return null;
}

// A key sent to the wrong host fails as "invalid key" at best, and at worst
// hands an Anthropic key to someone else. When the key's prefix names a
// provider, use that provider. Custom endpoints keep whatever key they get.
export function fixProviderForKey(s: Settings): void {
  const owner = s.apiKey ? providerForKey(s.apiKey) : null;
  if (owner && owner !== s.provider && (s.provider !== "custom" || owner === "anthropic")) {
    s.provider = owner;
    s.baseUrl = PROVIDERS[owner].baseUrl;
    s.model = PROVIDERS[owner].model;
  }
  if (s.provider !== "anthropic" && !s.baseUrl) s.baseUrl = PROVIDERS[s.provider].baseUrl;
  if (!s.model) s.model = PROVIDERS[s.provider].model;
}

// Pasted keys and tokens often carry a space or line break from the copy.
export const cleanSecret = (value: string): string => value.replace(/\s+/g, "");
