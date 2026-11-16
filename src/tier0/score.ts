// Signals -> score. Spec: PLAN.md §4. Score = clamp(0, 100, category sum + structure points - reductions).
import type { Churn } from "../git";
import type { FileKind, Hunk, Reason, ScoredHunk } from "../types";
import {
  type DiffContext,
  type Rules,
  buildDiffContext,
  categorySignals,
  fileKindOf,
  isTrivialHunk,
  structureSignals,
} from "./signals";

export type Unrouted = Omit<ScoredHunk, "tier">;

const sum = (rs: Reason[]) => rs.reduce((a, r) => a + r.weight, 0);
const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function scoreHunk(h: Hunk, kind: FileKind, ctx: DiffContext, rules: Rules, cats?: Reason[]): Unrouted {
  const cfg = rules.cfg;
  if (kind === "generated") {
    return { ...h, fileKind: kind, score: 0, reasons: [{ signal: "generated", weight: 0, detail: "generated or vendored file, never sent to a model" }] };
  }
  const reasons = [...(cats ?? categorySignals(h, kind, rules)), ...structureSignals(h, kind, ctx, cfg)];
  let score = sum(reasons);

  if (kind === "test" && !reasons.some((r) => r.signal === "tests_weakened" || r.signal === "assertions_removed")) {
    const r = cfg.reductions.test_file_without_test_signal;
    reasons.push({ signal: "test_file", weight: -r, detail: "test file with no test-weakening signal" });
    score -= r;
  }
  const cap = cfg.reductions.docs_or_trivial_cap;
  const capReason = kind === "docs" ? "documentation file" : isTrivialHunk(h) ? "only comments, whitespace or import reordering" : null;
  if (capReason && score > cap) {
    reasons.push({ signal: "cap", weight: cap - score, detail: `${capReason}: score capped at ${cap}` });
    score = cap;
  }
  return { ...h, fileKind: kind, score: clamp(score), reasons };
}

export function scoreHunks(hunks: Hunk[], rules: Rules, churn: Record<string, Churn> | null = null): Unrouted[] {
  const kinds = new Map<string, FileKind>();
  for (const h of hunks) if (!kinds.has(h.file)) kinds.set(h.file, fileKindOf(h.file, rules));
  const cats = new Map<Hunk, Reason[]>();
  let weakened = false;
  for (const h of hunks) {
    const kind = kinds.get(h.file) as FileKind;
    if (kind === "generated") continue;
    const c = categorySignals(h, kind, rules);
    cats.set(h, c);
    if (c.some((r) => r.signal === "tests_weakened")) weakened = true;
  }
  const ctx = buildDiffContext(hunks, kinds, weakened, churn);
  return hunks.map((h) => scoreHunk(h, kinds.get(h.file) as FileKind, ctx, rules, cats.get(h)));
}
