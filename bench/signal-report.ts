// What one risk category does to Tier 0 routing on the benchmark cases. No model calls, no API calls.
//   node .bench-build/signal-report.js <category> [--split dev|test|all] [--weights 0,10,25]
// For each case: the hunks where the category fires (with the matched line), each hunk's tier with the category at
// weight 0 (routing as if it did not exist) and at each weight, whether a faulty hunk is among them, and per split:
// routing recall, share of hunks sent to Opus, and the dry-run estimated cost (claude-code backend, tierview arm).
// Choosing a weight or a pattern must use the dev split only (PLAN §9); the test rows are description, not tuning.
import { type Config, loadConfig } from "../src/config";
import { estimatePlan, loadEstimates } from "../src/estimate";
import { loadPrices } from "../src/prices";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import type { ScoredHunk } from "../src/types";
import { armPreset } from "./arms";
import { faultyHunks, loadCases } from "./routing";
import { BENCH } from "./lib/sh";

export function withWeight(cfg: Config, category: string, weight: number): Config {
  const c = cfg.categories[category];
  if (!c) throw new Error(`unknown category ${category}`);
  return { ...cfg, categories: { ...cfg.categories, [category]: { ...c, weight } } };
}

export interface SplitSummary {
  split: string;
  weight: number;
  buggy: number;
  faultyHigh: number;
  reviewable: number;
  toOpus: number;
  toOpusClean: number;
  reviewableClean: number;
  estUsd: number;
  firesOn: { cases: number; buggyCases: number; cleanCases: number; hunks: number; faultyHunks: number };
}

export interface HunkFire {
  caseId: string;
  kind: string;
  split: string;
  hunk: string;
  faulty: boolean;
  detail: string;
  tierAt0: number;
  tierAtW: number;
  scoreAt0: number;
  scoreAtW: number;
}

/** Routing for every case of a split under one weight of the category. */
export function summarise(base: Config, category: string, weight: number, split: string): { s: SplitSummary; fires: HunkFire[] } {
  const prices = loadPrices();
  const est = loadEstimates();
  const tvW = armPreset("tierview", withWeight(base, category, weight)).cfg;
  const tv0 = armPreset("tierview", withWeight(base, category, 0)).cfg;
  const s: SplitSummary = { split, weight, buggy: 0, faultyHigh: 0, reviewable: 0, toOpus: 0, toOpusClean: 0, reviewableClean: 0, estUsd: 0, firesOn: { cases: 0, buggyCases: 0, cleanCases: 0, hunks: 0, faultyHunks: 0 } };
  const fires: HunkFire[] = [];
  for (const { c, diff } of loadCases().filter((x) => split === "all" || x.c.split === split)) {
    const hunks = parseDiff(diff);
    const routed: ScoredHunk[] = routeDiff(hunks, tvW, null);
    const at0 = new Map(routeDiff(hunks, tv0, null).map((h) => [h.id, h]));
    const reviewable = routed.filter((h) => h.tier !== 0);
    const faulty = new Set(c.kind === "buggy" ? faultyHunks(routed, c.faulty).map((h) => h.id) : []);
    s.reviewable += reviewable.length;
    s.toOpus += reviewable.filter((h) => h.tier >= 2).length;
    if (c.kind === "clean") {
      s.reviewableClean += reviewable.length;
      s.toOpusClean += reviewable.filter((h) => h.tier >= 2).length;
    } else {
      s.buggy++;
      if (routed.some((h) => faulty.has(h.id) && h.tier >= 2)) s.faultyHigh++;
    }
    s.estUsd += estimatePlan(routed, tvW, prices, est, "claude-code").total_usd;
    // Fires = the category matched (weight-independent: look at the weight-0 routing's reasons too).
    const hit = routeDiff(hunks, withWeight(base, category, 1), null).filter((h) => h.reasons.some((r) => r.signal === category));
    if (hit.length) {
      s.firesOn.cases++;
      if (c.kind === "buggy") s.firesOn.buggyCases++;
      else s.firesOn.cleanCases++;
    }
    for (const h of hit) {
      s.firesOn.hunks++;
      if (faulty.has(h.id)) s.firesOn.faultyHunks++;
      const w = routed.find((x) => x.id === h.id)!;
      const z = at0.get(h.id)!;
      fires.push({ caseId: c.id, kind: c.kind, split: c.split, hunk: h.id, faulty: faulty.has(h.id), detail: h.reasons.find((r) => r.signal === category)!.detail, tierAt0: z.tier, tierAtW: w.tier, scoreAt0: z.score, scoreAtW: w.score });
    }
  }
  return { s, fires };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const category = process.argv[2];
  if (!category || category.startsWith("--")) throw new Error("usage: signal-report.js <category> [--split dev|test|all] [--weights 0,10,25]");
  const base = loadConfig({ cwd: BENCH });
  const current = base.categories[category]?.weight ?? 0;
  const weights = (arg("weights") ?? `0,${current}`).split(",").map(Number);
  const splits = (arg("split") ?? "dev,test").split(",");
  for (const split of splits) {
    const { fires } = summarise(base, category, current, split);
    console.log(`\n## ${split}: where "${category}" fires (current weight ${current})`);
    if (!fires.length) console.log("  (nowhere)");
    for (const f of fires) console.log(`  ${f.kind.padEnd(5)} ${f.caseId.padEnd(36)} ${f.hunk.padEnd(48)} ${f.faulty ? "FAULTY " : "       "} tier ${f.tierAt0} -> ${f.tierAtW} (score ${f.scoreAt0} -> ${f.scoreAtW})  [${f.detail}]`);
    console.log(`\n  weight | routing recall | hunks to Opus (all / clean) | est. cost, sum over cases (tierview, dry run)`);
    for (const w of weights) {
      const { s } = summarise(base, category, w, split);
      console.log(`  ${String(w).padStart(6)} | ${s.faultyHigh}/${s.buggy}            | ${s.toOpus}/${s.reviewable} = ${((s.toOpus / s.reviewable) * 100).toFixed(1)}% / ${s.toOpusClean}/${s.reviewableClean} = ${((s.toOpusClean / Math.max(1, s.reviewableClean)) * 100).toFixed(1)}% | $${s.estUsd.toFixed(3)}`);
    }
    const { s } = summarise(base, category, current, split);
    console.log(`  fires on ${s.firesOn.hunks} hunk(s) in ${s.firesOn.cases} case(s) (${s.firesOn.buggyCases} buggy, ${s.firesOn.cleanCases} clean); on ${s.firesOn.faultyHunks} faulty hunk(s)`);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/signal-report.js")) main();
