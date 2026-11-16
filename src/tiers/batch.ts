// Packs hunks into requests. Spec: PLAN.md §5 (API request units), §5a (claude-code batching).
import type { Config } from "../config";
import type { Estimates } from "../estimate";
import type { Backend, LlmTier, ScoredHunk } from "../types";

export interface PackLimits {
  /** "batch": pack across files up to the limits; "file": one request per file, no limits. */
  mode: "batch" | "file";
  maxHunks: number;
  maxTokens: number;
}

export function limitsFor(backend: Backend, tier: LlmTier, cfg: Config, est: Estimates): PackLimits {
  if (backend === "claude-code") {
    const c = cfg.backend.claude_code;
    return { mode: "batch", maxHunks: c.max_hunks_per_call, maxTokens: c.max_tokens_per_call };
  }
  if (tier === 1) return { mode: "batch", maxHunks: est.tier1_batch.max_hunks, maxTokens: est.tier1_batch.max_tokens };
  return { mode: "file", maxHunks: Infinity, maxTokens: Infinity };
}

const hunkIndex = (h: ScoredHunk) => Number(h.id.slice(h.id.lastIndexOf("#") + 1));

/**
 * Groups hunks into requests. A file's hunks stay together unless the file alone exceeds the limits,
 * in which case it is split by hunk. Order is stable: files by path, hunks by index.
 */
export function packHunks<H extends ScoredHunk>(hunks: H[], limits: PackLimits, tokensOf: (h: H) => number): H[][] {
  const byFile = new Map<string, H[]>();
  for (const h of [...hunks].sort((a, b) => a.file.localeCompare(b.file) || hunkIndex(a) - hunkIndex(b))) {
    const g = byFile.get(h.file);
    if (g) g.push(h);
    else byFile.set(h.file, [h]);
  }
  const groups = [...byFile.values()];
  if (limits.mode === "file") return groups;

  const out: H[][] = [];
  let cur: H[] = [];
  let curTokens = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    curTokens = 0;
  };
  const fits = (n: number, t: number) => cur.length + n <= limits.maxHunks && curTokens + t <= limits.maxTokens;
  for (const g of groups) {
    const gTokens = g.reduce((a, h) => a + tokensOf(h), 0);
    if (fits(g.length, gTokens)) {
      cur.push(...g);
      curTokens += gTokens;
      continue;
    }
    flush();
    if (g.length <= limits.maxHunks && gTokens <= limits.maxTokens) {
      cur.push(...g);
      curTokens = gTokens;
      continue;
    }
    for (const h of g) {
      const t = tokensOf(h);
      if (cur.length && !fits(1, t)) flush();
      cur.push(h);
      curTokens += t;
    }
  }
  flush();
  return out;
}
