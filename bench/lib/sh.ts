// Small process helpers for the benchmark scripts: `gh api` for GitHub, `git` for local blobless clones.
// The benchmark only reads public repositories. Spec: PLAN.md §9.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Bench scripts run from the repository root (`npm run bench:*`). */
export const BENCH = resolve("bench");
export const REPOS = join(BENCH, "repos");

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET a GitHub REST path with `gh api`. Params go as -f fields. */
export function ghGet<T = unknown>(path: string, params: Record<string, string | number> = {}): T {
  const args = ["api", "-X", "GET", path];
  for (const [k, v] of Object.entries(params)) args.push("-f", `${k}=${v}`);
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out) as T;
}

/** Local bare clone directory for owner/name. */
export const repoDir = (repo: string) => join(REPOS, `${repo.replace("/", "_")}.git`);

/** Blobless, bare, single-branch clone: commits and trees locally, blobs fetched on demand. */
export function ensureClone(repo: string): string {
  const dir = repoDir(repo);
  if (!existsSync(dir)) {
    mkdirSync(REPOS, { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", "--single-branch", "--filter=blob:none", `https://github.com/${repo}`, dir], { stdio: "inherit" });
  }
  return dir;
}

export function git(dir: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (opts.allowFail) return "";
    throw e;
  }
}
