// Hard budget cap: degrade plan before the run, reserve / settle during it. Spec: PLAN.md §7.
// On the claude-code backend the cap applies to the API-equivalent cost (a proxy for plan usage).
import type { Config } from "./config";
import { type Estimates, estimatePlan } from "./estimate";
import type { ModelPrice, Prices } from "./prices";
import { tiersMerged } from "./tiers/collapse";
import type { Backend, ScoredHunk } from "./types";

/** Worst case of one request: estimated input at the input price plus max_tokens at the output price. */
export function worstCase(inputTokens: number, maxTokens: number, p: ModelPrice): number {
  return (inputTokens * p.input + maxTokens * p.output) / 1e6;
}

export class Ledger {
  spent = 0;
  private reserved = new Map<number, number>();
  private next = 1;
  constructor(readonly cap: number | null) {}

  get outstanding(): number {
    let s = 0;
    for (const v of this.reserved.values()) s += v;
    return s;
  }

  /** Returns a ticket, or null when spent + reserved + amount would pass the cap. */
  reserve(amount: number): number | null {
    if (this.cap !== null && this.spent + this.outstanding + amount > this.cap) return null;
    const t = this.next++;
    this.reserved.set(t, amount);
    return t;
  }

  settle(ticket: number, actual: number): void {
    this.reserved.delete(ticket);
    this.spent += actual;
  }
}

export interface DegradeResult {
  routed: ScoredHunk[];
  /** Hunk ids dropped as not_reviewed: budget. */
  dropped: string[];
  degraded: boolean;
  /** Human-readable moves, for the receipt. */
  moves: string[];
}

/**
 * Before any call: while the estimate plus the escalation reserve exceeds the cap, move the lowest-scoring
 * Tier 3 hunk to Tier 2, then Tier 2 to Tier 1, then drop the lowest-scoring Tier 1 hunk.
 */
export function degradePlan(routed: ScoredHunk[], cfg: Config, prices: Prices, est: Estimates, cap: number, backend: Backend): DegradeResult {
  const hunks = routed.map((h) => ({ ...h, reasons: [...h.reasons] }));
  const dropped: string[] = [];
  const moves: string[] = [];
  const fits = () => {
    const p = estimatePlan(hunks, cfg, prices, est, backend);
    return p.total_usd + p.reserve_usd <= cap;
  };
  while (!fits()) {
    const lowest = (t: number) =>
      hunks.filter((h) => h.tier === t && !dropped.includes(h.id)).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))[0];
    const h = lowest(3) ?? lowest(2) ?? lowest(1);
    if (!h) break;
    if (h.tier === 1) {
      dropped.push(h.id);
      h.tier = 0;
      h.reasons.push({ signal: "budget", weight: 0, detail: "dropped to fit --max-cost" });
      moves.push(`${h.id}: dropped (budget)`);
    } else {
      // With Tier 2 and Tier 3 merged (same model) there is no cheaper Tier 2: go straight to Tier 1.
      const to = (h.tier === 3 && tiersMerged(cfg) ? 1 : h.tier - 1) as 1 | 2;
      h.reasons.push({ signal: "budget", weight: 0, detail: `moved from tier ${h.tier} to ${to} to fit --max-cost` });
      moves.push(`${h.id}: tier ${h.tier} -> ${to}`);
      h.tier = to;
    }
  }
  return { routed: hunks, dropped, degraded: moves.length > 0, moves };
}
