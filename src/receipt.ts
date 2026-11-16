// Builds the Receipt. Spec: PLAN.md §7 (Receipt), §8.
import type { Config } from "./config";
import { type Estimates, estimateBaseline } from "./estimate";
import type { ModelUsage } from "./llm/backend";
import { type Prices, costOfModels } from "./prices";
import type { Backend, LlmTier, ModelSubstitution, Receipt, ScoredHunk, TierReceipt } from "./types";

/** One request as it actually ran. */
export interface CallRecord {
  tier: LlmTier;
  /** Model the router asked for. */
  requested: string;
  /** Model that did the work. */
  model: string;
  hunkIds: string[];
  usageByModel: Record<string, ModelUsage>;
  /** Model calls, retries included. */
  calls: number;
  cost: number;
  /** True for escalation rounds. */
  escalation: boolean;
}

export interface ReceiptInput {
  backend: Backend;
  cfg: Config;
  prices: Prices;
  est: Estimates;
  /** Routing after any budget degrade (tier 0 = skipped or dropped). */
  routed: ScoredHunk[];
  records: CallRecord[];
  escalatedIn: Record<LlmTier, number>;
  /** Hunks reviewed by Tier 3 (for the baseline's output-per-hunk). */
  tier3Reviewed: number;
  skipped: number;
  notReviewed: number;
  maxCost: number | null;
  degraded: boolean;
  substitutions: ModelSubstitution[];
  warnings: string[];
  wallMs: number;
}

const key = (t: LlmTier) => `tier${t}` as const;

export function buildReceipt(x: ReceiptInput): Receipt {
  const warnings = [...x.warnings];
  const tiers: TierReceipt[] = ([1, 2, 3] as LlmTier[]).map((t) => {
    const recs = x.records.filter((r) => r.tier === t);
    const counts = new Map<string, number>();
    for (const r of recs) counts.set(r.model, (counts.get(r.model) ?? 0) + r.hunkIds.length);
    const model = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? x.cfg.models[key(t)].model;
    const sum = { input: 0, cw: 0, cr: 0, out: 0 };
    for (const r of recs) {
      for (const u of Object.values(r.usageByModel)) {
        sum.input += u.usage.input_tokens;
        sum.cw += u.usage.cache_creation_input_tokens;
        sum.cr += u.usage.cache_read_input_tokens;
        sum.out += u.usage.output_tokens;
      }
    }
    return {
      tier: t,
      model,
      effort: x.cfg.models[key(t)].effort,
      hunks: x.routed.filter((h) => h.tier === t).length,
      escalated_in: x.escalatedIn[t],
      requests: recs.reduce((a, r) => a + r.calls, 0),
      input_tokens: sum.input,
      cache_write_tokens: sum.cw,
      cache_read_tokens: sum.cr,
      output_tokens: sum.out,
      cost_usd: recs.reduce((a, r) => a + r.cost, 0),
    };
  });

  const unpriced = new Set<string>();
  for (const r of x.records) for (const m of costOfModels(r.usageByModel, x.prices).unpriced) unpriced.add(m);
  if (unpriced.size) warnings.push(`no price in config/prices.json for ${[...unpriced].join(", ")}; used the cost the backend reported.`);

  const total = tiers.reduce((a, t) => a + t.cost_usd, 0);
  const t3 = tiers[2]!;
  // Tier 3's measured output per hunk stands in for the baseline only when Tier 3 ran the baseline model.
  const t3Out = x.tier3Reviewed >= 3 && t3.output_tokens > 0 && t3.model === x.cfg.receipt.baseline.model ? t3.output_tokens / x.tier3Reviewed : undefined;
  const baseline = estimateBaseline(x.routed, x.cfg, x.prices, x.est, t3Out);

  for (const t of tiers) {
    if (t.tier === 3) continue;
    const base = x.routed.filter((h) => h.tier === t.tier).length + t.escalated_in;
    const out = x.escalatedIn[(t.tier + 1) as LlmTier];
    if (base > 0 && out / base > x.cfg.escalation.max_rate) {
      warnings.push(`calibration: ${out} of ${base} tier ${t.tier} hunk(s) escalated (${Math.round((out / base) * 100)}% > ${Math.round(x.cfg.escalation.max_rate * 100)}%).`);
    }
  }

  return {
    backend: x.backend,
    cost_basis: x.backend === "claude-code" ? "api_equivalent" : "billed",
    calls: x.records.reduce((a, r) => a + r.calls, 0),
    model_substitutions: x.substitutions,
    tiers,
    skipped_hunks: x.skipped,
    not_reviewed_hunks: x.notReviewed,
    total_cost_usd: total,
    baseline,
    savings_pct: baseline.cost_usd > 0 ? Math.round((1 - total / baseline.cost_usd) * 1000) / 10 : 0,
    budget: { max_cost_usd: x.maxCost, degraded: x.degraded },
    warnings,
    wall_ms: Math.round(x.wallMs),
    prices_as_of: x.prices.as_of,
  };
}
