// System prompts, the shared context and the per-request user message. Spec: PLAN.md §5, §8.
// Everything here must be byte-stable for the same input: no timestamps, no random ids, stable ordering.
import type { ContextBlock } from "../tiers/context";
import type { Finding, Hunk, LlmTier, ScoredHunk } from "../types";

const COMMON = `You are a code reviewer inside tierview, a tool that reviews a diff one hunk at a time and routes each hunk to a reviewer tier by risk.

What to report
- Only real defects that this change introduces or exposes: bugs, security problems, concurrency errors, data loss, performance regressions, broken API contracts, missing or wrong error handling, and weakened tests.
- Do not report style, naming, formatting, or "consider adding a comment". Do not invent problems to look thorough; a clean hunk is a good answer.
- Judge the change, not the whole file. A problem in unchanged code counts only when the change makes it reachable or worse.

How to read the input
- Each hunk has an id such as "src/app.ts#2". Diff lines are printed as "<old> <new> <marker> <text>", where the marker is "+" (added), "-" (deleted) or " " (unchanged), and a blank number means the line does not exist on that side.
- Context blocks, when present, show the new version of the file with new-file line numbers.
- The shared context lists every hunk in the diff with its tier and risk score, so you can see what else changed.

How to answer
- Return exactly one review per hunk id you were given, using the same ids, and no others.
- verdict: "clean" when you have no findings, "issues" when you have at least one, "unsure" when you cannot judge without more context. "clean" with findings and "issues" without findings are contradictions; do not produce them.
- confidence (0 to 1): your probability that the verdict and findings are right. Be honest; low confidence is useful, false certainty is not.
- needs_escalation: true when a stronger reviewer with more context should look at this hunk; give the reason in escalation_reason, else "".
- Findings: file is the hunk's file path. start_line and end_line are line numbers inside this hunk. side is "new" for added or unchanged lines (new-file numbers) and "old" for a problem on a deleted line (old-file numbers). title is at most 80 characters. explanation says what goes wrong and when. suggestion is a concrete fix, or "". evidence quotes the offending line exactly. confidence is per finding.
- Severity: "critical" = exploitable security hole, data loss or corruption, or a crash on a common path; "high" = wrong behaviour users will hit; "medium" = wrong behaviour in edge cases or a clear performance regression; "low" = minor defect with limited impact; "info" = worth knowing, not a defect.
- refuted_prior: ids of prior findings you checked and found wrong; [] when there are none.`;

const TIER: Record<LlmTier, string> = {
  1: `You are the Tier 1 reviewer: fast, for hunks that scored low risk. You see each hunk with only the diff's own three lines of context. When correctness depends on code you cannot see, do not guess: answer "unsure", set needs_escalation, and say what you would need to see. There are no prior findings at this tier, so refuted_prior is always [].`,
  2: `You are the Tier 2 reviewer, for medium-risk hunks and for hunks the Tier 1 reviewer escalated. You see about 30 lines of the new file around each hunk. Some hunks carry prior findings from Tier 1 with ids: verify or refute each one. List the ids you refute in refuted_prior; re-report a finding you confirm in your own findings (fix its line numbers or severity if they were wrong). Escalate when the hunk needs the whole file or the enclosing function to judge.`,
  3: `You are the Tier 3 reviewer, the final and most thorough tier, for high-risk hunks and for hunks the lower tiers escalated. You see the whole file when it is short, otherwise about 80 lines around the hunk and the start of the enclosing function. Some hunks carry prior findings from Tiers 1 and 2 with ids: verify or refute each one. List the ids you refute in refuted_prior; re-report a finding you confirm in your own findings. There is no tier above you, so needs_escalation is always false; express doubt through confidence instead.`,
};

/** The system prompt for a tier. Identical bytes on every call. */
export function systemPrompt(tier: LlmTier): string {
  return `${COMMON}\n\n${TIER[tier]}`;
}

export interface PrInfo {
  title?: string;
  body?: string;
}

/** Shared context: identical for every request of a run (and therefore of a tier). */
export function sharedContext(routed: ScoredHunk[], pr: PrInfo = {}): string {
  const out: string[] = ["# Change under review"];
  if (pr.title) out.push(`Title: ${pr.title.trim()}`);
  if (pr.body?.trim()) out.push("Description:", pr.body.trim());
  const files = new Map<string, { added: number; deleted: number; status: string }>();
  for (const h of [...routed].sort((a, b) => a.id.localeCompare(b.id))) {
    const f = files.get(h.file) ?? { added: 0, deleted: 0, status: h.status };
    f.added += h.added;
    f.deleted += h.deleted;
    files.set(h.file, f);
  }
  out.push("", "## Changed files (path, status, +added/-deleted)");
  for (const [path, f] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) out.push(`${path} ${f.status} +${f.added}/-${f.deleted}`);
  out.push("", "## Hunk map (id, tier, risk score; tier 0 = skipped)");
  for (const h of [...routed].sort((a, b) => a.id.localeCompare(b.id))) out.push(`${h.id} tier=${h.tier} score=${h.score}`);
  return out.join("\n");
}

const num = (n: number | undefined) => (n === undefined ? "" : String(n)).padStart(5);

/** The hunk with old/new line numbers, as described in the system prompt. */
export function numberedHunk(h: Hunk): string {
  const out = [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.header}`.trimEnd()];
  for (const l of h.lines) out.push(`${num(l.oldNo)} ${num(l.newNo)} ${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`);
  return out.join("\n");
}

export interface HunkInput {
  hunk: ScoredHunk;
  context: ContextBlock | null;
  prior: Finding[];
}

/** One hunk's block in the user message. Its size drives request packing. */
export function hunkBlock(x: HunkInput): string {
  const h = x.hunk;
  const out = [`### hunk ${h.id}`, `file: ${h.file}${h.oldFile ? ` (renamed from ${h.oldFile})` : ""}, status: ${h.status}, risk score: ${h.score}`, "<diff>", numberedHunk(h), "</diff>"];
  if (x.context) {
    out.push(`<context lines="${x.context.start}-${x.context.end}" kind="${x.context.kind}">`);
    x.context.lines.forEach((l, i) => out.push(`${num(x.context!.start + i)} | ${l}`));
    out.push("</context>");
  }
  if (x.prior.length) {
    out.push("<prior_findings>");
    for (const f of x.prior) {
      out.push(
        JSON.stringify({ id: f.id, tier: f.tier, model: f.model, file: f.file, start_line: f.start_line, end_line: f.end_line, side: f.side, severity: f.severity, category: f.category, title: f.title, explanation: f.explanation, evidence: f.evidence, confidence: f.confidence }),
      );
    }
    out.push("</prior_findings>");
  }
  return out.join("\n");
}

export function userMessage(blocks: string[], ids: string[]): string {
  return [`Review these ${ids.length} hunk(s). Return exactly one review for each of these ids: ${ids.join(", ")}.`, "", ...blocks.flatMap((b) => [b, ""])].join("\n").trimEnd();
}
