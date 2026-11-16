// The two cost views and the all-Fable figure, computed one way for the receipt, the dry run and the benchmark.
// Spec: PLAN.md §7 (Receipt).
//
// - "via Claude Code" (claude-code backend) / "billed" (api backend): the tokens that actually ran, at list prices.
// - "direct API": the same tokens without Claude Code's per-call overhead (its structured-output tool and second
//   turn, `claude_code_overhead_tokens_per_call` in config/estimates.json), the remaining input-side tokens at the
//   uncached input rate. On the api backend it equals the billed cost.
// - all-Fable (the receipt baseline): the same actual tokens priced at the baseline model's rates (Fable 5.2).
//   It is a calculation, not a measurement: a real all-Fable run would send different tokens.
import { type Prices, priceFor } from "./prices";
import type { Backend } from "./types";

export interface TokenTotals {
  input_tokens: number;
  cache_write_tokens: number;
  /** Part of cache_write_tokens with the 1-hour TTL. Missing: all of them on claude-code, none on api. */
  cache_write_1h_tokens?: number;
  cache_read_tokens: number;
  output_tokens: number;
  /** Model calls that produced these tokens. */
  requests: number;
}

const inputSide = (t: TokenTotals) => t.input_tokens + t.cache_write_tokens + t.cache_read_tokens;

/** Tokens at a model's list prices (cache writes split by TTL). */
export function priceTokens(t: TokenTotals, model: string, prices: Prices, backend: Backend): number {
  const p = priceFor(model, prices);
  const oneHour = t.cache_write_1h_tokens ?? (backend === "claude-code" ? t.cache_write_tokens : 0);
  return (t.input_tokens * p.input + (t.cache_write_tokens - oneHour) * p.cache_write_5m + oneHour * (p.cache_write_1h ?? p.cache_write_5m) + t.cache_read_tokens * p.cache_read + t.output_tokens * p.output) / 1e6;
}

/** Direct-API view of the same tokens (see the header). `overheadPerCall` is 0 on the api backend. */
export function directApiCost(t: TokenTotals, model: string, prices: Prices, backend: Backend, overheadPerCall: number): number {
  if (backend === "api") return priceTokens(t, model, prices, backend);
  const p = priceFor(model, prices);
  const input = Math.max(0, inputSide(t) - overheadPerCall * t.requests);
  return (input * p.input + t.output_tokens * p.output) / 1e6;
}

export interface CostViews {
  /** Actual cost of the run: via Claude Code on claude-code, billed on api. */
  actual_usd: number;
  direct_api_usd: number;
  /** The same tokens at the baseline model's rates: actual basis and direct-API basis. */
  baseline_usd: number;
  baseline_direct_api_usd: number;
}

/**
 * All four figures from per-tier token totals. `actualPerTier` is the cost already computed per tier (from the
 * per-model usage, so a tier that fell back to another model is priced right); the other views use `tier.model`.
 */
export function costViews(
  tiers: (TokenTotals & { model: string; cost_usd: number })[],
  baselineModel: string,
  prices: Prices,
  backend: Backend,
  overheadPerCall: number,
): CostViews {
  const v: CostViews = { actual_usd: 0, direct_api_usd: 0, baseline_usd: 0, baseline_direct_api_usd: 0 };
  for (const t of tiers) {
    if (!t.requests && !t.output_tokens && !inputSide(t)) continue;
    v.actual_usd += t.cost_usd;
    v.direct_api_usd += backend === "api" ? t.cost_usd : directApiCost(t, t.model, prices, backend, overheadPerCall);
    v.baseline_usd += priceTokens(t, baselineModel, prices, backend);
    v.baseline_direct_api_usd += directApiCost(t, baselineModel, prices, backend, overheadPerCall);
  }
  return v;
}

export const savingsPct = (cost: number, baseline: number) => (baseline > 0 ? Math.round((1 - cost / baseline) * 1000) / 10 : 0);
