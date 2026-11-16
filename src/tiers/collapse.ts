// Tier 2 and Tier 3 on the same model run as one tier. Spec: PLAN.md §5a, §6.
// With Fable off on the claude-code backend both tiers are Opus 5.5, so two separate Opus calls (medium, then high)
// would pay Claude Code's per-call overhead twice for no gain. Tier 2 hunks fold into Tier 3, which runs at the
// higher of the two efforts, and Tier 1 escalates straight to Tier 3.
import type { Config } from "../config";
import type { Effort } from "../llm/backend";
import type { ScoredHunk } from "../types";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const tiersMerged = (cfg: Config) => cfg.models.tier2.model === cfg.models.tier3.model;

export function collapseTiers(cfg: Config, routed: ScoredHunk[]): { cfg: Config; routed: ScoredHunk[]; merged: boolean } {
  if (!tiersMerged(cfg)) return { cfg, routed, merged: false };
  const e2 = EFFORTS.indexOf(cfg.models.tier2.effort as Effort);
  const e3 = EFFORTS.indexOf(cfg.models.tier3.effort as Effort);
  const effort = EFFORTS[Math.max(e2, e3)]!;
  const merged: Config = { ...cfg, models: { ...cfg.models, tier3: { ...cfg.models.tier3, effort } } };
  const out = routed.map((h) =>
    h.tier === 2
      ? { ...h, tier: 3 as const, reasons: [...h.reasons, { signal: "merge", weight: 0, detail: `Tier 2 and Tier 3 run the same model: one call at ${effort} effort` }] }
      : h,
  );
  return { cfg: merged, routed: out, merged: true };
}
