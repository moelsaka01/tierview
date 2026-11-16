// The contract between modules. Spec: PLAN.md §4 (hunks) and §8 (schemas).
// The model-output schemas (ModelFinding, HunkReview, TierResponse) are sent to the API as
// structured-output formats, which cannot express numeric ranges or string lengths.
// Keep those schemas free of .min()/.max() and enforce ranges in code after parsing.
import { z } from "zod";

export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof Severity>;
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export const Category = z.enum([
  "bug",
  "security",
  "concurrency",
  "data-loss",
  "performance",
  "api-contract",
  "error-handling",
  "test",
  "maintainability",
]);
export type Category = z.infer<typeof Category>;

export const Verdict = z.enum(["clean", "issues", "unsure"]);
export type Verdict = z.infer<typeof Verdict>;

// ---- Tier 0 -------------------------------------------------------------

export type FileKind = "generated" | "docs" | "test" | "config" | "source";
export type FileStatus = "added" | "modified" | "deleted" | "renamed";
/** 0 = skipped (never sent to a model). */
export type Tier = 0 | 1 | 2 | 3;
export type LlmTier = 1 | 2 | 3;

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  /** "<path>#<n>", n = 1-based index of the hunk within its file. */
  id: string;
  file: string;
  oldFile?: string;
  status: FileStatus;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second @@ (usually the enclosing function). */
  header: string;
  lines: DiffLine[];
  added: number;
  deleted: number;
}

export interface Reason {
  signal: string;
  weight: number;
  detail: string;
}

export interface ScoredHunk extends Hunk {
  fileKind: FileKind;
  score: number;
  tier: Tier;
  reasons: Reason[];
}

// ---- Model output (structured-output schemas) ---------------------------

export const ModelFinding = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  side: z.enum(["new", "old"]),
  severity: Severity,
  category: Category,
  title: z.string(),
  explanation: z.string(),
  suggestion: z.string(),
  evidence: z.string(),
  confidence: z.number(),
});
export type ModelFinding = z.infer<typeof ModelFinding>;

export const HunkReview = z.object({
  hunk_id: z.string(),
  verdict: Verdict,
  confidence: z.number(),
  needs_escalation: z.boolean(),
  escalation_reason: z.string(),
  refuted_prior: z.array(z.string()),
  findings: z.array(ModelFinding),
});
export type HunkReview = z.infer<typeof HunkReview>;

export const TierResponse = z.object({ reviews: z.array(HunkReview) });
export type TierResponse = z.infer<typeof TierResponse>;

// ---- Final output -------------------------------------------------------

export const Finding = ModelFinding.extend({
  id: z.string(),
  hunk_id: z.string(),
  model: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  escalated_from: z.array(z.union([z.literal(1), z.literal(2)])),
  also_reported_by: z.array(z.string()),
});
export type Finding = z.infer<typeof Finding>;

export const TierReceipt = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  model: z.string(),
  effort: z.string(),
  hunks: z.number().int(),
  escalated_in: z.number().int(),
  requests: z.number().int(),
  input_tokens: z.number().int(),
  cache_write_tokens: z.number().int(),
  cache_read_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number(),
});
export type TierReceipt = z.infer<typeof TierReceipt>;

export const Backend = z.enum(["claude-code", "api"]);
export type Backend = z.infer<typeof Backend>;

export const ModelSubstitution = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  requested: z.string(),
  used: z.string(),
  reason: z.string(),
});
export type ModelSubstitution = z.infer<typeof ModelSubstitution>;

export const Receipt = z.object({
  /** Which backend ran the models. */
  backend: Backend,
  /** "billed": API list-price cost of this run. "api_equivalent": claude-code backend; tokens priced at API list prices, not what the plan bills. */
  cost_basis: z.enum(["billed", "api_equivalent"]),
  /** Model calls made (API requests or `claude -p` invocations), retries included. */
  calls: z.number().int(),
  model_substitutions: z.array(ModelSubstitution),
  tiers: z.array(TierReceipt),
  skipped_hunks: z.number().int(),
  not_reviewed_hunks: z.number().int(),
  total_cost_usd: z.number(),
  baseline: z.object({
    model: z.string(),
    method: z.literal("estimated"),
    cost_usd: z.number(),
  }),
  savings_pct: z.number(),
  budget: z.object({ max_cost_usd: z.number().nullable(), degraded: z.boolean() }),
  warnings: z.array(z.string()),
  wall_ms: z.number().int(),
  prices_as_of: z.string(),
});
export type Receipt = z.infer<typeof Receipt>;

export const Review = z.object({
  version: z.literal(1),
  findings: z.array(Finding),
  refuted: z.array(Finding),
  not_reviewed: z.array(z.object({ hunk_id: z.string(), reason: z.string() })),
  routing: z.array(
    z.object({
      hunk_id: z.string(),
      score: z.number(),
      tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      reasons: z.array(z.object({ signal: z.string(), weight: z.number(), detail: z.string() })),
    }),
  ),
  receipt: Receipt,
});
export type Review = z.infer<typeof Review>;

/** Token usage of one API response, as reported by the SDK. */
export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  /** Part of cache_creation_input_tokens written with the 1-hour TTL (Claude Code on a plan uses it). */
  cache_creation_1h_input_tokens?: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export const EXIT = { OK: 0, FINDINGS: 1, USAGE: 2, BUDGET: 3 } as const;
