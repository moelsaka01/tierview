// A scripted ReviewBackend for tests. Never touches the network or the claude binary.
import { type ModelUsage, type ReviewBackend, type ReviewRequest, type ReviewResult, addUsage } from "../src/llm/backend";
import type { Backend, HunkReview, ModelFinding, ModelSubstitution } from "../src/types";

export type Script = (req: ReviewRequest) => Partial<Record<string, Partial<HunkReview> | "omit">> | { fail: "refusal" | "parse" | "error" };

export function clean(id: string, confidence = 0.9): HunkReview {
  return { hunk_id: id, verdict: "clean", confidence, needs_escalation: false, escalation_reason: "", refuted_prior: [], findings: [] };
}

export function finding(file: string, line: number, over: Partial<ModelFinding> = {}): ModelFinding {
  return {
    file,
    start_line: line,
    end_line: line,
    side: "new",
    severity: "medium",
    category: "bug",
    title: "Off-by-one in loop bound",
    explanation: "The loop reads one element past the end of the array.",
    suggestion: "Use < instead of <=.",
    evidence: "for (i = 0; i <= n; i++)",
    confidence: 0.8,
    ...over,
  };
}

export class FakeBackend implements ReviewBackend {
  readonly requests: ReviewRequest[] = [];
  subs: ModelSubstitution[] = [];
  constructor(
    private readonly script: Script,
    readonly name: Backend = "api",
    readonly concurrency = 4,
    /** Usage reported per request. */
    private readonly usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 },
  ) {}

  substitutions(): ModelSubstitution[] {
    return this.subs;
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    this.requests.push(req);
    const usageByModel: Record<string, ModelUsage> = {};
    addUsage(usageByModel, req.model, this.usage);
    const s = this.script(req);
    if ("fail" in s) {
      const reason = (s as { fail: "refusal" | "parse" | "error" }).fail;
      return { ok: false, reason, detail: "scripted", model: req.model, usageByModel, calls: 1 };
    }
    const over = s as Partial<Record<string, Partial<HunkReview> | "omit">>;
    const reviews = req.hunkIds.filter((id) => over[id] !== "omit").map((id) => ({ ...clean(id), ...(over[id] as Partial<HunkReview> | undefined) }));
    return { ok: true, response: { reviews }, model: req.model, usageByModel, calls: 1 };
  }
}
