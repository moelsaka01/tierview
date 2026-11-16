// Token and cost estimates for --dry-run and the all-Fable baseline. Spec: PLAN.md §5 (request shapes), §7.
// Estimates ignore prompt caching (no cache-read discount) and escalations; the reserve covers the latter.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config";
import { type Prices, loadPrices, priceFor } from "./prices";
import { configPath } from "./root";
import { formatHunk } from "./tier0/diff";
import { limitsFor, packHunks } from "./tiers/batch";
import type { Backend, LlmTier, ScoredHunk } from "./types";

const PerTier = z.object({ tier1: z.number(), tier2: z.number(), tier3: z.number() });
const EstimatesFile = z.object({
  calibrated: z.boolean(),
  note: z.string().optional(),
  chars_per_token: z.number().positive(),
  system_prompt_tokens: z.number(),
  shared_context_tokens_per_file: z.number(),
  shared_context_tokens_per_hunk: z.number(),
  context_tokens_per_hunk: PerTier,
  output_tokens_per_hunk: PerTier,
  tier1_batch: z.object({ max_hunks: z.number(), max_tokens: z.number() }),
  escalation_reserve: z.number(),
  /** Tokens Claude Code adds to every `claude -p` call (its structured-output tool and second turn). */
  claude_code_overhead_tokens_per_call: z.number().default(0),
});
export type Estimates = z.infer<typeof EstimatesFile>;

export function loadEstimates(path = configPath("estimates.json")): Estimates {
  return EstimatesFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function estimateTokens(text: string, est: Estimates): number {
  return Math.ceil(text.length / est.chars_per_token);
}

export interface TierEstimate {
  tier: LlmTier;
  model: string;
  effort: string;
  hunks: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface Plan {
  tiers: TierEstimate[];
  total_usd: number;
  /** Allowance for escalations (escalation_reserve x total). Not included in total_usd. */
  reserve_usd: number;
  baseline: { model: string; method: "estimated"; cost_usd: number };
  backend: Backend;
  /** Savings of total_usd + reserve_usd against the baseline, as a percentage. */
  savings_pct: number;
  skipped_hunks: number;
  calibrated: boolean;
}

const key = (t: LlmTier) => `tier${t}` as "tier1" | "tier2" | "tier3";

function requestsFor(tier: LlmTier, hunks: ScoredHunk[], tokens: Map<string, number>, cfg: Config, est: Estimates, backend: Backend): number {
  if (hunks.length === 0) return 0;
  const ctx = est.context_tokens_per_hunk[key(tier)];
  return packHunks(hunks, limitsFor(backend, tier, cfg, est), (h) => (tokens.get(h.id) as number) + (backend === "claude-code" ? ctx : 0)).length;
}

function estimateTier(
  tier: LlmTier,
  hunks: ScoredHunk[],
  all: ScoredHunk[],
  cfg: Config,
  prices: Prices,
  est: Estimates,
  tokens: Map<string, number>,
  backend: Backend,
  model = cfg.models[key(tier)].model,
  outputPerHunk = est.output_tokens_per_hunk[key(tier)],
): TierEstimate {
  const m = cfg.models[key(tier)];
  const p = priceFor(model, prices);
  const requests = requestsFor(tier, hunks, tokens, cfg, est, backend);
  const files = new Set(all.map((h) => h.file)).size;
  const shared = files * est.shared_context_tokens_per_file + all.length * est.shared_context_tokens_per_hunk;
  const perRequest = est.system_prompt_tokens + shared + (backend === "claude-code" ? est.claude_code_overhead_tokens_per_call : 0);
  let input = requests * perRequest;
  for (const h of hunks) input += (tokens.get(h.id) as number) + est.context_tokens_per_hunk[key(tier)];
  const output = Math.round(hunks.length * outputPerHunk);
  return {
    tier,
    model,
    effort: m.effort,
    hunks: hunks.length,
    requests,
    input_tokens: input,
    output_tokens: output,
    cost_usd: (input * p.input + output * p.output) / 1e6,
  };
}

/**
 * The all-Fable baseline (§7): every reviewable hunk as a Tier 3 API request (one per file, same context
 * builder), priced at the receipt's baseline model (config `receipt.baseline`, Fable 5.2 by default). `outputPerHunk` comes from the run's own Tier 3 usage
 * when it reviewed >= 3 hunks.
 */
export function estimateBaseline(
  routed: ScoredHunk[],
  cfg: Config,
  prices: Prices = loadPrices(),
  est: Estimates = loadEstimates(),
  outputPerHunk?: number,
): { model: string; method: "estimated"; cost_usd: number } {
  const reviewable = routed.filter((h) => h.tier !== 0);
  const tokens = new Map(reviewable.map((h) => [h.id, estimateTokens(formatHunk(h), est)]));
  const b = estimateTier(3, reviewable, reviewable, cfg, prices, est, tokens, "api", cfg.receipt.baseline.model, outputPerHunk);
  return { model: b.model, method: "estimated", cost_usd: b.cost_usd };
}

export function estimatePlan(
  routed: ScoredHunk[],
  cfg: Config,
  prices: Prices = loadPrices(),
  est: Estimates = loadEstimates(),
  backend: Backend = "api",
): Plan {
  const reviewable = routed.filter((h) => h.tier !== 0);
  const tokens = new Map(reviewable.map((h) => [h.id, estimateTokens(formatHunk(h), est)]));
  const tiers = ([1, 2, 3] as LlmTier[]).map((t) =>
    estimateTier(t, reviewable.filter((h) => h.tier === t), reviewable, cfg, prices, est, tokens, backend),
  );
  const total = tiers.reduce((a, t) => a + t.cost_usd, 0);
  const base = estimateBaseline(routed, cfg, prices, est);
  const reserve = total * est.escalation_reserve;
  return {
    tiers,
    total_usd: total,
    reserve_usd: reserve,
    baseline: base,
    savings_pct: base.cost_usd > 0 ? Math.round((1 - (total + reserve) / base.cost_usd) * 1000) / 10 : 0,
    backend,
    skipped_hunks: routed.length - reviewable.length,
    calibrated: est.calibrated,
  };
}
