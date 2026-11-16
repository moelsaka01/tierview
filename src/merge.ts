// Dedupe, refutation and ranking of findings. Spec: PLAN.md §7 (Merge), §8 (Finding.id).
import { createHash } from "node:crypto";
import { type Finding, type LlmTier, type ModelFinding, SEVERITY_ORDER } from "./types";

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** sha1(file|start|end|category|normalized title).slice(0, 12) */
export function findingId(f: Pick<ModelFinding, "file" | "start_line" | "end_line" | "category" | "title">): string {
  return createHash("sha1").update(`${f.file}|${f.start_line}|${f.end_line}|${f.category}|${normTitle(f.title)}`).digest("hex").slice(0, 12);
}

export function toFinding(f: ModelFinding, hunkId: string, model: string, tier: LlmTier, escalatedFrom: (1 | 2)[]): Finding {
  return { ...f, id: findingId(f), hunk_id: hunkId, model, tier, escalated_from: [...escalatedFrom], also_reported_by: [] };
}

const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export const DUP = { lineSlack: 3, minJaccard: 0.5 } as const;

/** Same file and category, line ranges within ±3 lines, title+explanation Jaccard ≥ 0.5. */
export function isDuplicate(a: Finding, b: Finding): boolean {
  if (a.file !== b.file || a.category !== b.category) return false;
  if (a.start_line > b.end_line + DUP.lineSlack || b.start_line > a.end_line + DUP.lineSlack) return false;
  return jaccard(`${a.title} ${a.explanation}`, `${b.title} ${b.explanation}`) >= DUP.minJaccard;
}

export function rankFindings(fs: Finding[]): Finding[] {
  return [...fs].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.confidence - a.confidence ||
      b.tier - a.tier ||
      a.file.localeCompare(b.file) ||
      a.start_line - b.start_line,
  );
}

/**
 * `refutedBy` maps a finding id to the highest tier that listed it in `refuted_prior`.
 * A finding is refuted only by a tier above its own. Duplicates keep the highest tier's version.
 */
export function mergeFindings(all: Finding[], refutedBy: Map<string, LlmTier>): { findings: Finding[]; refuted: Finding[] } {
  const refuted: Finding[] = [];
  const live: Finding[] = [];
  for (const f of all) {
    const by = refutedBy.get(f.id);
    if (by !== undefined && by > f.tier) refuted.push(f);
    else live.push(f);
  }
  const order = [...live].sort((a, b) => b.tier - a.tier || b.confidence - a.confidence);
  const kept: Finding[] = [];
  for (const f of order) {
    const dup = kept.find((k) => isDuplicate(k, f));
    if (dup) {
      const who = `${f.model} (tier ${f.tier})`;
      if (!dup.also_reported_by.includes(who) && (dup.model !== f.model || dup.tier !== f.tier)) dup.also_reported_by.push(who);
      continue;
    }
    kept.push({ ...f, also_reported_by: [...f.also_reported_by] });
  }
  return { findings: rankFindings(kept), refuted: rankFindings(refuted) };
}
