// Escalation decisions (pure). Spec: PLAN.md §6.
import type { Config } from "../config";
import { type Hunk, type HunkReview, type ModelFinding, SEVERITY_ORDER, type Severity } from "../types";

export interface EscalationRule {
  minConfidence: number;
  /** Findings at or above this severity go up a tier for confirmation (E3). */
  verifySeverity: Severity;
}

export function ruleFor(from: 1 | 2, cfg: Config): EscalationRule {
  const e = cfg.escalation;
  const sev = (from === 1 ? e.tier1_verify_severity : e.tier2_verify_severity) as Severity;
  if (!SEVERITY_ORDER.includes(sev)) throw new Error(`escalation.tier${from}_verify_severity must be one of ${SEVERITY_ORDER.join(", ")}`);
  return { minConfidence: from === 1 ? e.tier1_min_confidence : e.tier2_min_confidence, verifySeverity: sev };
}

const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
export const atOrAbove = (s: Severity, threshold: Severity) => rank(s) <= rank(threshold);

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export const TITLE_MAX = 80;

/** Client-side checks the structured-output schema cannot express: ranges and lengths (§0, §8). */
export function sanitizeReview(r: HunkReview): HunkReview {
  return {
    ...r,
    confidence: clamp01(r.confidence),
    findings: r.findings.map((f) => ({
      ...f,
      confidence: clamp01(f.confidence),
      title: f.title.length > TITLE_MAX ? `${f.title.slice(0, TITLE_MAX - 1)}…` : f.title,
      start_line: Math.min(f.start_line, f.end_line),
      end_line: Math.max(f.start_line, f.end_line),
    })),
  };
}

/** Line range of a hunk on one side, widened by `slack` lines. */
function hunkRange(h: Hunk, side: "new" | "old", slack: number): [number, number] {
  const start = side === "new" ? h.newStart : h.oldStart;
  const len = side === "new" ? h.newLines : h.oldLines;
  return [Math.max(0, start - slack), start + Math.max(len, 1) - 1 + slack];
}

const overlaps = (a: ModelFinding, b: ModelFinding) => a.side === b.side && a.start_line <= b.end_line && b.start_line <= a.end_line;

/** E4: deterministic contradictions in one hunk's review. */
export function contradictions(r: HunkReview, h: Hunk, slack = 3): string[] {
  const out: string[] = [];
  if (r.verdict === "clean" && r.findings.length) out.push("E4a verdict clean but findings reported");
  if (r.verdict === "issues" && !r.findings.length) out.push("E4a verdict issues but no findings");
  for (const f of r.findings) {
    if (f.file !== h.file && f.file !== h.oldFile) {
      out.push(`E4b finding "${f.title}" cites ${f.file}, outside the hunk`);
      continue;
    }
    const [lo, hi] = hunkRange(h, f.side, slack);
    if (f.start_line < lo || f.end_line > hi) out.push(`E4b finding "${f.title}" cites lines ${f.start_line}-${f.end_line} (${f.side}), outside the hunk`);
  }
  for (let i = 0; i < r.findings.length; i++) {
    for (let j = i + 1; j < r.findings.length; j++) {
      const a = r.findings[i]!;
      const b = r.findings[j]!;
      if (overlaps(a, b) && Math.abs(rank(a.severity) - rank(b.severity)) >= 2) out.push(`E4c overlapping findings with severities ${a.severity} and ${b.severity}`);
    }
  }
  return out;
}

export interface EscalationDecision {
  escalate: boolean;
  reasons: string[];
}

/**
 * Whether a hunk moves up from `from` (1 or 2). `review` is null when the request failed or the hunk was
 * missing from the response; `failure` then says why (E5).
 */
export function decideEscalation(review: HunkReview | null, h: Hunk, rule: EscalationRule, failure?: string): EscalationDecision {
  if (!review) return { escalate: true, reasons: [`E5 ${failure ?? "missing from the response"}`] };
  const reasons: string[] = [];
  if (review.confidence < rule.minConfidence) reasons.push(`E1 confidence ${review.confidence.toFixed(2)} < ${rule.minConfidence}`);
  if (review.needs_escalation) reasons.push(`E2 model asked to escalate${review.escalation_reason ? `: ${review.escalation_reason}` : ""}`);
  const severe = review.findings.filter((f) => atOrAbove(f.severity, rule.verifySeverity));
  if (severe.length) reasons.push(`E3 ${severe.length} finding(s) at ${rule.verifySeverity} or above need confirmation`);
  reasons.push(...contradictions(review, h));
  return { escalate: reasons.length > 0, reasons };
}
