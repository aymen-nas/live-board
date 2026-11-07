// Boards synced from a private GitHub repository: Claude Code writes each
// meeting board to boards/<date> <name>.txt there, the app lists and loads
// them with a read-only token, so nothing has to be pasted on the phone.

export interface RemoteBoard {
  name: string; // file name without .txt, e.g. "2026-11-04 Standup"
  path: string;
}

export interface GitHubSource {
  repo: string; // "owner/name"
  token: string;
}

const API = "https://api.github.com";

function headers(token: string, raw = false): HeadersInit {
  return {
    Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 401) throw new Error("GitHub token rejected (expired or wrong)");
  if (res.status === 404) throw new Error("Repository or boards/ folder not found, or the token can't see it");
  throw new Error(`GitHub ${res.status} ${res.statusText}`);
}

export interface RemoteListing {
  boards: RemoteBoard[];
  // Classic and OAuth tokens list their scopes; they can do far more than
  // read one repo, so the app suggests a fine-grained read-only token.
  broadToken: boolean;
}

export async function listRemoteBoards(src: GitHubSource, signal?: AbortSignal): Promise<RemoteListing> {
  const res = await check(await fetch(`${API}/repos/${src.repo}/contents/boards`, { headers: headers(src.token), signal, cache: "no-cache" }));
  const items = (await res.json()) as { type: string; name: string; path: string }[];
  const boards = items
    .filter((i) => i.type === "file" && i.name.endsWith(".txt"))
    .map((i) => ({ name: i.name.replace(/\.txt$/, ""), path: i.path }))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest date first
  return { boards, broadToken: (res.headers.get("x-oauth-scopes") ?? "").trim() !== "" };
}

export async function fetchRemoteBoard(src: GitHubSource, path: string, signal?: AbortSignal): Promise<string> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await check(
    await fetch(`${API}/repos/${src.repo}/contents/${encoded}`, { headers: headers(src.token, true), signal, cache: "no-cache" }),
  );
  return res.text();
}
