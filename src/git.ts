// Local git access. Spec: PLAN.md §3, §4 (churn needs history; shallow clone -> zeros).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiffOptions {
  base?: string;
  head?: string;
  staged?: boolean;
  /** Also diff untracked, non-ignored files as new files. Working-tree diffs only. */
  includeUntracked?: boolean;
  cwd?: string;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Unified diff via `git diff --no-color -U3 -M`. No head = compare base with the working tree. */
export function getDiff(opts: DiffOptions = {}): string {
  const args = ["diff", "--no-color", "-U3", "-M"];
  if (opts.staged) args.push("--cached");
  args.push(opts.base ?? "HEAD");
  if (opts.head) args.push(opts.head);
  let out = git(args, opts.cwd);
  if (opts.includeUntracked) {
    if (opts.head || opts.staged) throw new Error("--include-untracked only works on a working-tree diff (no --head, no --staged)");
    for (const f of untrackedFiles(opts.cwd)) out += diffNewFile(f, opts.cwd);
  }
  return out;
}

/** Untracked files that are not ignored, relative to the repo root, sorted. */
export function untrackedFiles(cwd?: string): string[] {
  const root = repoRoot(cwd);
  return git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    .split("\0")
    .filter(Boolean)
    .sort();
}

/** `git diff --no-index /dev/null <file>`: the file as an all-added diff (exit code 1 means "differs"). */
function diffNewFile(path: string, cwd?: string): string {
  try {
    return git(["diff", "--no-color", "-U3", "--no-index", "--", "/dev/null", path], repoRoot(cwd));
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1 && typeof err.stdout === "string") return err.stdout;
    throw e;
  }
}

export function repoRoot(cwd?: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

/** Reads the new side of a file for context: working tree, the index (staged) or a ref. null when absent. */
export type FileSource = (path: string) => string | null;

export function fileSource(opts: DiffOptions = {}): FileSource {
  const root = repoRoot(opts.cwd);
  return (path) => {
    try {
      if (opts.head) return git(["show", `${opts.head}:${path}`], root);
      if (opts.staged) return git(["show", `:${path}`], root);
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
}

export function isShallow(cwd?: string): boolean {
  try {
    return git(["rev-parse", "--is-shallow-repository"], cwd).trim() === "true";
  } catch {
    return true; // not a repo: treat as no history
  }
}

export interface Churn {
  commits: number;
  fixCommits: number;
}

/**
 * Commits touching each path in the last `days` days, from one `git log` call.
 * `fixPattern` is a regex source matched case-insensitively against commit subjects.
 * Every requested path is present in the result; all zero on a shallow clone or outside a repo.
 */
export function fileChurn(paths: string[], days: number, fixPattern = "\\bfix(es|ed)?\\b|bug|regress", cwd?: string): Record<string, Churn> {
  const out: Record<string, Churn> = {};
  for (const p of paths) out[p] = { commits: 0, fixCommits: 0 };
  if (paths.length === 0 || isShallow(cwd)) return out;
  const fixRe = new RegExp(fixPattern, "i");
  let log: string;
  try {
    log = git(["log", `--since=${days}.days`, "--no-merges", "--name-only", "--format=%x1e%s"], cwd);
  } catch {
    return out;
  }
  for (const entry of log.split("\x1e")) {
    if (!entry.trim()) continue;
    const [subject = "", ...files] = entry.split("\n");
    const isFix = fixRe.test(subject);
    for (const f of new Set(files.map((x) => x.trim()).filter(Boolean))) {
      const c = out[f];
      if (!c) continue;
      c.commits++;
      if (isFix) c.fixCommits++;
    }
  }
  return out;
}
