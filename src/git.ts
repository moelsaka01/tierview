// Local git access. Spec: PLAN.md §3, §4 (churn needs history; shallow clone -> zeros).
import { execFileSync } from "node:child_process";

export interface DiffOptions {
  base?: string;
  head?: string;
  staged?: boolean;
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
  return git(args, opts.cwd);
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
