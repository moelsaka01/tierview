// JSON output. The dry-run shape is its own thing; the full Review shape (PLAN §8) arrives in Phase 3.
import type { Plan } from "../estimate";
import type { Review, ScoredHunk } from "../types";
import type { DryRunView } from "./terminal";

export function dryRunJson(v: DryRunView & { pricesAsOf: string }): string {
  const { routed, plan } = v;
  return (
    JSON.stringify(
      {
        version: 1,
        dry_run: true,
        routing: routed.map((h: ScoredHunk) => ({ hunk_id: h.id, file_kind: h.fileKind, score: h.score, tier: h.tier, reasons: h.reasons })),
        estimate: { ...(plan as Plan), prices_as_of: v.pricesAsOf },
        max_cost_usd: v.maxCost,
        warnings: v.warnings,
      },
      null,
      2,
    ) + "\n"
  );
}

/** The full Review (PLAN §8). */
export function reviewJson(r: Review): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
