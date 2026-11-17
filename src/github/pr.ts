// GitHub pull-request access with plain fetch (no Octokit: a few GET calls do not need it). Spec: PLAN.md §10.
import type { FileSource } from "../git";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrData {
  ref: PrRef;
  title: string;
  body: string;
  headSha: string;
  diff: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class GithubError extends Error {}

export function parsePrUrl(url: string): PrRef {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  if (!m) throw new GithubError(`not a GitHub pull request URL: ${url} (expected https://github.com/<owner>/<repo>/pull/<number>)`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export function apiBase(): string {
  return (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
}

export function ghHeaders(token: string | undefined, accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tierview" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function ghRequest(f: FetchLike, url: string, token: string | undefined, accept?: string, init: { method?: string; body?: string } = {}): Promise<string> {
  const res = await f(url, { ...init, headers: { ...ghHeaders(token, accept), ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 404 ? " (not found; for a private repo set GITHUB_TOKEN)" : res.status === 401 || res.status === 403 ? " (check GITHUB_TOKEN and its permissions)" : "";
    throw new GithubError(`GitHub API ${init.method ?? "GET"} ${url.replace(apiBase(), "")} failed: HTTP ${res.status}${hint}`);
  }
  return text;
}

/** Title, body, head sha and the unified diff of a pull request. */
export async function fetchPr(url: string, token: string | undefined, f: FetchLike = fetch as unknown as FetchLike): Promise<PrData> {
  const ref = parsePrUrl(url);
  const base = `${apiBase()}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const meta = JSON.parse(await ghRequest(f, base, token)) as { title?: string; body?: string | null; head?: { sha?: string } };
  const diff = await ghRequest(f, base, token, "application/vnd.github.diff");
  if (!meta.head?.sha) throw new GithubError("GitHub returned a pull request without a head sha.");
  return { ref, title: meta.title ?? "", body: meta.body ?? "", headSha: meta.head.sha, diff };
}

/**
 * File context without a checkout: the contents API at the head sha. FileSource is synchronous, so the
 * files are fetched up front (at most `limit`, four at a time) and served from a map. Missing or
 * unreadable files are null, which the pipeline already handles.
 */
export async function prefetchFiles(ref: PrRef, sha: string, paths: string[], token: string | undefined, f: FetchLike = fetch as unknown as FetchLike, limit = 60): Promise<FileSource> {
  const cache = new Map<string, string | null>();
  const todo = [...new Set(paths)].slice(0, limit);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++]!;
      const url = `${apiBase()}/repos/${ref.owner}/${ref.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`;
      try {
        cache.set(p, await ghRequest(f, url, token, "application/vnd.github.raw+json"));
      } catch {
        cache.set(p, null);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return (p) => cache.get(p) ?? null;
}
