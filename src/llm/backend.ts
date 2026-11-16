// The backend contract. Spec: PLAN.md §5, §5a. Implementations: llm/client.ts (API, the only SDK importer)
// and llm/claude-code.ts (the official `claude` CLI). Tests use test/fake-client.ts.
import { type Backend, type LlmTier, type ModelSubstitution, TierResponse, type Usage } from "../types";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ReviewRequest {
  tier: LlmTier;
  model: string;
  effort: Effort;
  /** Tier system prompt (llm/prompts.ts). */
  system: string;
  /** Shared context; the cache prefix ends here. */
  shared: string;
  /** The hunks of this request. */
  user: string;
  hunkIds: string[];
  /** API backend: put a cache_control marker on the shared context. Ignored by claude-code. */
  cache: boolean;
  maxTokens: number;
  /** claude-code backend: model to use when `model` is unavailable on the plan. */
  fallbackModel?: string;
}

export interface ModelUsage {
  usage: Usage;
  /** Cost the backend itself reported, used only for models missing from config/prices.json. */
  reportedCostUsd?: number;
}

interface Common {
  /** The model that did the work (the response's `model` field, or the dominant model for claude-code). */
  model: string;
  /** Usage per model across all attempts of this request. */
  usageByModel: Record<string, ModelUsage>;
  /** Model calls made for this request, retries included. */
  calls: number;
}

export type ReviewResult =
  | (Common & { ok: true; response: TierResponse })
  | (Common & { ok: false; reason: "refusal" | "parse" | "error"; detail: string });

export interface ReviewBackend {
  readonly name: Backend;
  /** Requests a tier may run at once (claude-code: 1). */
  readonly concurrency: number;
  review(req: ReviewRequest): Promise<ReviewResult>;
  /** Models that ran in place of the requested ones during this run. */
  substitutions(): ModelSubstitution[];
}

/** Unrecoverable setup problem (missing key or binary). The CLI exits 2. */
export class BackendSetupError extends Error {}

export const ZERO_USAGE: Usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };

export function addUsage(into: Record<string, ModelUsage>, model: string, u: Usage, reportedCostUsd?: number): void {
  const cur = into[model] ?? { usage: { ...ZERO_USAGE } };
  const prev1h = cur.usage.cache_creation_1h_input_tokens;
  cur.usage = {
    input_tokens: cur.usage.input_tokens + u.input_tokens,
    cache_creation_input_tokens: cur.usage.cache_creation_input_tokens + u.cache_creation_input_tokens,
    cache_read_input_tokens: cur.usage.cache_read_input_tokens + u.cache_read_input_tokens,
    output_tokens: cur.usage.output_tokens + u.output_tokens,
  };
  const oneHour = (prev1h ?? 0) + (u.cache_creation_1h_input_tokens ?? 0);
  if (oneHour) cur.usage.cache_creation_1h_input_tokens = oneHour;
  if (reportedCostUsd !== undefined) cur.reportedCostUsd = (cur.reportedCostUsd ?? 0) + reportedCostUsd;
  into[model] = cur;
}

/** Validates a parsed structured output against the schema (the transport may already have done so). */
export function parseTierResponse(value: unknown): TierResponse | null {
  const r = TierResponse.safeParse(value);
  return r.success ? r.data : null;
}
