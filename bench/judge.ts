// P4-06: did a run catch the bug? Rules first; Opus only for findings the rules cannot decide. Spec: PLAN.md §9.
// Every judgement (rule or model) is logged to bench/results/judgements.jsonl with its reason.
// Judge v2 (frozen with bench-config-v1): for wide fixes, a location match also needs a mechanism term.
import { z } from "zod";
import { parseDiff } from "../src/tier0/diff";
import type { Finding, Hunk } from "../src/types";
import type { BenchCase } from "./validate";

/** Bumped when the rules change; metrics use judgements of the current version only. */
export const JUDGE_VERSION = 2;

export const RULE = {
  matchWithin: 3,
  ambiguousWithin: 10,
  /** A fix whose faulty lines in a file span more than this many lines is "wide". */
  wideSpan: 8,
  /** For wide fixes, a location match needs at least this many mechanism terms in the finding's text. */
  minMechanismTerms: 2,
  minTermLength: 4,
} as const;

/** Words that never count as a key term (English glue and generic bug-report words). */
export const STOPWORDS = new Set(
  (
    "the a an and or of to in on at by for with from into onto as is are was were be been being it its this that these those when while which who " +
    "whom whose what where why how not no nor but if then than so such only also just even both each every all any some more most less least very " +
    "can could would should will shall may might must do does did done has have had having fix fixes fixed fixing bug bugs issue problem wrong " +
    "incorrect correct correctly instead because after before again still now new add added adds use used uses using make makes made get gets got " +
    "set sets call calls called line lines code value values function functions case cases one two first last next same other don dont doesn isn " +
    "wasn cause causes caused break breaks broken " +
    // generic outcome and filler words: they say a bug happens, not how
    "fail fails failed failure crash crashes crashed error errors every later right left hand reach reaches their them they there cannot " +
    "nothing large larger finish finishes slower faster"
  ).split(/\s+/),
);

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");

/** Words of a text: each identifier whole and split at `_` and camelCase boundaries, lowercased, 3+ characters. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    out.push(tok.toLowerCase());
    for (const part of tok.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) if (part.length >= 3) out.push(part.toLowerCase());
  }
  return out;
}

/** Stemmed word set of a text (see words()). */
export function stems(text: string): Set<string> {
  return new Set(words(text).map(stem));
}

/**
 * Mechanism terms of a case: words of the bug description and the fix subject, minus stopwords, minus anything that
 * also occurs in the reviewed diff (names of the code under review appear in every finding about it, so they say
 * nothing about whether the finding understood the bug).
 */
export function mechanismTerms(c: Pick<BenchCase, "fix">, diff: string): string[] {
  if (!c.fix) return [];
  const text = `${c.fix.bug} ${c.fix.subject.replace(/^Fixed #\d+(, Refs #\d+)? -- /, "").replace(/^[\w./-]+: /, "")}`;
  const inDiff = stems(diff);
  const terms = words(text).filter((w) => !STOPWORDS.has(w)).map(stem);
  return [...new Set(terms)].filter((t) => t.length >= RULE.minTermLength && !STOPWORDS.has(t) && !inDiff.has(t)).sort();
}

/** Everything the judge's rules and prompt depend on; part of the frozen config hash (bench/run.ts). */
export function judgeConfig(): string {
  return JSON.stringify({ version: JUDGE_VERSION, rule: RULE, stop: [...STOPWORDS].sort(), system: JUDGE_SYSTEM, model: "tier2 model of the frozen config", effort: "medium" });
}

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
  /** JUDGE_VERSION that made this judgement; missing = 1. */
  judge_version?: number;
  /** Model judgements only. */
  model?: string;
  confidence?: number;
  /** Batch in which this judgement was made. */
  batch?: string;
  /** Batch of the run being judged (missing in early logs: same as batch). */
  run_batch?: string;
  at?: string;
}

type Located = Pick<Finding, "file" | "start_line" | "end_line" | "side"> & Partial<Pick<Finding, "title" | "explanation" | "evidence" | "suggestion">>;

/** Distance in lines from [a, b] to the nearest of `lines` (0 when one is inside). */
export function distanceTo(a: number, b: number, lines: number[]): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(...lines.map((l) => (l < lo ? lo - l : l > hi ? l - hi : 0)));
}

const overlaps = (a: number, b: number, c: number, d: number) => Math.min(a, b) <= d && Math.max(a, b) >= c;

/**
 * The rules. match: new side of a faulty file, within ±3 lines of a faulty line, and, when the fix is wide (faulty
 * lines in that file span more than 8 lines), the finding's text names at least one mechanism term. no_match: another
 * file, or more than 10 lines from every faulty line and outside every faulty hunk. ambiguous: everything in between
 * (inside a faulty hunk, 4–10 lines away, old side of a faulty hunk, or a wide-fix location match without a
 * mechanism term).
 */
export function classify(f: Located, c: Pick<BenchCase, "faulty">, hunks: Hunk[], mechanism: string[] = []): { cls: Verdict | "ambiguous"; reason: string; distance: number | null } {
  const fault = c.faulty.filter((x) => x.file === f.file);
  if (!fault.length) return { cls: "no_match", reason: `file ${f.file} has no faulty line`, distance: null };
  const lines = fault.flatMap((x) => x.lines);
  const faultyHunks = hunks.filter((h) => h.file === f.file && lines.some((l) => l >= h.newStart && l < h.newStart + Math.max(h.newLines, 1)));
  if (f.side === "old") {
    const inHunk = faultyHunks.some((h) => overlaps(f.start_line, f.end_line, h.oldStart, h.oldStart + Math.max(h.oldLines, 1) - 1));
    return inHunk ? { cls: "ambiguous", reason: "old-side finding inside a faulty hunk", distance: null } : { cls: "no_match", reason: "old-side finding outside every faulty hunk", distance: null };
  }
  const d = distanceTo(f.start_line, f.end_line, lines);
  if (d <= RULE.matchWithin) {
    const span = Math.max(...lines) - Math.min(...lines) + 1;
    if (span <= RULE.wideSpan) return { cls: "match", reason: `within ${d} line(s) of a faulty line`, distance: d };
    const text = stems(`${f.title ?? ""} ${f.explanation ?? ""} ${f.evidence ?? ""} ${f.suggestion ?? ""}`);
    const hits = mechanism.filter((t) => text.has(t));
    if (hits.length >= RULE.minMechanismTerms) return { cls: "match", reason: `within ${d} line(s) of a faulty line; wide fix (span ${span}), mechanism terms: ${hits.join(", ")}`, distance: d };
    return { cls: "ambiguous", reason: `within ${d} line(s) of a faulty line, but wide fix (span ${span}) and no mechanism term (${mechanism.join(", ") || "none"})`, distance: d };
  }
  const inHunk = faultyHunks.some((h) => overlaps(f.start_line, f.end_line, h.newStart, h.newStart + Math.max(h.newLines, 1) - 1));
  if (d <= RULE.ambiguousWithin || inHunk) return { cls: "ambiguous", reason: `${d} lines from a faulty line${inHunk ? ", inside a faulty hunk" : ""}`, distance: d };
  return { cls: "no_match", reason: `${d} lines from the nearest faulty line, outside every faulty hunk`, distance: d };
}

/** Rule pass over one run's findings against the case's diff. Returns rule judgements and the findings left for the model judge. */
export function ruleJudge(c: BenchCase, arm: string, findings: Finding[], diff: string): { judged: Judgement[]; ambiguous: { finding: Finding; reason: string; distance: number | null }[] } {
  const hunks = parseDiff(diff);
  const mechanism = mechanismTerms(c, diff);
  const judged: Judgement[] = [];
  const ambiguous: { finding: Finding; reason: string; distance: number | null }[] = [];
  for (const f of findings) {
    const r = classify(f, c, hunks, mechanism);
    if (r.cls === "ambiguous") ambiguous.push({ finding: f, reason: r.reason, distance: r.distance });
    else judged.push(base(c, arm, f, "rule", r.cls, r.reason, r.distance));
  }
  return { judged, ambiguous };
}

function base(c: BenchCase, arm: string, f: Finding, method: Judgement["method"], verdict: Verdict, reason: string, distance: number | null): Judgement {
  return { case_id: c.id, arm, finding_id: f.id, file: f.file, start_line: f.start_line, end_line: f.end_line, side: f.side, severity: f.severity, title: f.title, method, verdict, reason, distance, judge_version: JUDGE_VERSION };
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
