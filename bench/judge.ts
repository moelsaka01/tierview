// P4-06: did a run catch the bug? Rules first; Opus only for findings the rules cannot decide. Spec: PLAN.md §9.
// Every judgement (rule or model) is logged to bench/results/judgements.jsonl with its reason.
import { z } from "zod";
import type { Finding, Hunk } from "../src/types";
import type { BenchCase } from "./validate";

export const RULE = { matchWithin: 3, ambiguousWithin: 10 } as const;

export type Verdict = "match" | "no_match";

export interface Judgement {
  case_id: string;
  arm: string;
  finding_id: string;
  file: string;
  start_line: number;
  end_line: number;
  side: "new" | "old";
  severity: string;
  title: string;
  method: "rule" | "model";
  verdict: Verdict;
  reason: string;
  /** Lines between the finding and the nearest faulty line (new side), null when not comparable. */
  distance: number | null;
  /** Model judgements only. */
  model?: string;
  confidence?: number;
  /** Batch in which this judgement was made. */
  batch?: string;
  /** Batch of the run being judged (missing in early logs: same as batch). */
  run_batch?: string;
  at?: string;
}

type Located = Pick<Finding, "file" | "start_line" | "end_line" | "side">;

/** Distance in lines from [a, b] to the nearest of `lines` (0 when one is inside). */
export function distanceTo(a: number, b: number, lines: number[]): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(...lines.map((l) => (l < lo ? lo - l : l > hi ? l - hi : 0)));
}

const overlaps = (a: number, b: number, c: number, d: number) => Math.min(a, b) <= d && Math.max(a, b) >= c;

/**
 * The location rule. match: new side of a faulty file, within ±3 lines of a faulty line. no_match: another file, or
 * more than 10 lines from every faulty line and outside every faulty hunk. ambiguous: everything in between
 * (inside a faulty hunk, 4–10 lines away, or on the old side of a faulty hunk).
 */
export function classify(f: Located, c: Pick<BenchCase, "faulty">, hunks: Hunk[]): { cls: Verdict | "ambiguous"; reason: string; distance: number | null } {
  const fault = c.faulty.filter((x) => x.file === f.file);
  if (!fault.length) return { cls: "no_match", reason: `file ${f.file} has no faulty line`, distance: null };
  const lines = fault.flatMap((x) => x.lines);
  const faultyHunks = hunks.filter((h) => h.file === f.file && lines.some((l) => l >= h.newStart && l < h.newStart + Math.max(h.newLines, 1)));
  if (f.side === "old") {
    const inHunk = faultyHunks.some((h) => overlaps(f.start_line, f.end_line, h.oldStart, h.oldStart + Math.max(h.oldLines, 1) - 1));
    return inHunk ? { cls: "ambiguous", reason: "old-side finding inside a faulty hunk", distance: null } : { cls: "no_match", reason: "old-side finding outside every faulty hunk", distance: null };
  }
  const d = distanceTo(f.start_line, f.end_line, lines);
  if (d <= RULE.matchWithin) return { cls: "match", reason: `within ${d} line(s) of a faulty line`, distance: d };
  const inHunk = faultyHunks.some((h) => overlaps(f.start_line, f.end_line, h.newStart, h.newStart + Math.max(h.newLines, 1) - 1));
  if (d <= RULE.ambiguousWithin || inHunk) return { cls: "ambiguous", reason: `${d} lines from a faulty line${inHunk ? ", inside a faulty hunk" : ""}`, distance: d };
  return { cls: "no_match", reason: `${d} lines from the nearest faulty line, outside every faulty hunk`, distance: d };
}

/** Rule pass over one run's findings. Returns the rule judgements and the findings left for the model judge. */
export function ruleJudge(c: BenchCase, arm: string, findings: Finding[], hunks: Hunk[]): { judged: Judgement[]; ambiguous: { finding: Finding; reason: string; distance: number | null }[] } {
  const judged: Judgement[] = [];
  const ambiguous: { finding: Finding; reason: string; distance: number | null }[] = [];
  for (const f of findings) {
    const r = classify(f, c, hunks);
    if (r.cls === "ambiguous") ambiguous.push({ finding: f, reason: r.reason, distance: r.distance });
    else judged.push(base(c, arm, f, "rule", r.cls, r.reason, r.distance));
  }
  return { judged, ambiguous };
}

function base(c: BenchCase, arm: string, f: Finding, method: Judgement["method"], verdict: Verdict, reason: string, distance: number | null): Judgement {
  return { case_id: c.id, arm, finding_id: f.id, file: f.file, start_line: f.start_line, end_line: f.end_line, side: f.side, severity: f.severity, title: f.title, method, verdict, reason, distance };
}

// ---- model judge -------------------------------------------------------------

export const JudgeResponse = z.object({
  judgements: z.array(
    z.object({
      finding: z.string().describe("the finding label, e.g. F1"),
      same_defect: z.boolean(),
      confidence: z.number().describe("0 to 1"),
      reason: z.string().describe("one sentence"),
    }),
  ),
});
export type JudgeResponse = z.infer<typeof JudgeResponse>;

export const JUDGE_SYSTEM = `You grade code review findings against a known bug. You are given a bug: the commit that introduced it was later fixed, and you see the fix's diff and a one-sentence description. You are also given review findings on the bug-introducing change, each labelled F1, F2, and so on.

For each finding, decide whether it describes the same defect that the fix repairs: the same faulty behaviour, at or near the code the fix changed. A finding that names the right lines but a different problem is not the same defect. A finding that describes the right problem in slightly different words, or with a different suggested fix, is the same defect. Severity and wording do not matter.

Return one judgement per finding label, with same_defect, a confidence from 0 to 1, and a one-sentence reason.`;

/** The model judge's user message. Blind to the arm and the model that wrote each finding. */
export function judgeUserMessage(c: BenchCase, fixDiff: string, items: { finding: Finding }[]): string {
  const out = [`# Bug`, c.fix?.bug ?? "", "", `# Fix commit: ${c.fix?.subject ?? ""}`, "```diff", fixDiff.trim(), "```", "", `# Findings on the bug-introducing change (${items.length})`];
  items.forEach(({ finding: f }, i) => {
    out.push(
      `## F${i + 1}`,
      `file: ${f.file}, lines ${f.start_line}-${f.end_line} (${f.side === "old" ? "deleted lines, old numbering" : "new numbering"}), severity ${f.severity}, category ${f.category}`,
      `title: ${f.title}`,
      `explanation: ${f.explanation}`,
      f.evidence ? `evidence: ${f.evidence}` : "",
      "",
    );
  });
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
}

/** Turns a model response into judgements; a finding the model skipped stays unjudged (null). */
export function modelJudgements(c: BenchCase, arm: string, items: { finding: Finding; reason: string; distance: number | null }[], res: JudgeResponse, model: string): (Judgement | null)[] {
  return items.map((it, i) => {
    const j = res.judgements.find((x) => x.finding.trim().toUpperCase() === `F${i + 1}`);
    if (!j) return null;
    return { ...base(c, arm, it.finding, "model", j.same_defect ? "match" : "no_match", `${j.reason} (rule: ${it.reason})`, it.distance), model, confidence: j.confidence };
  });
}

/** A run caught its case's bug when any finding was judged a match. */
export const caught = (js: Pick<Judgement, "verdict">[]) => js.some((j) => j.verdict === "match");

/** A deterministic sample of judgements for the hand audit (PLAN §9: 20). */
export function auditSample<T>(all: T[], n = 20, seed = 7): T[] {
  const a = [...all];
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}
