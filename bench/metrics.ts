// P4-07: every metric in PLAN.md §9 from saved runs and judgements. No model calls.
//   node .bench-build/metrics.js [--split test|dev|all]   -> bench/results/results.json + a markdown table on stdout
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { estimateBaseline, loadEstimates } from "../src/estimate";
import { costOf, loadPrices } from "../src/prices";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import { SEVERITY_ORDER, type Severity, type Usage } from "../src/types";
import { ARMS, type Arm, armPreset } from "./arms";
import type { Judgement } from "./judge";
import { faultyHunks, loadCases } from "./routing";
import { type RunFile, readRun } from "./run";
import type { BenchCase } from "./validate";
import { BENCH } from "./lib/sh";

// ---- statistics (pure, tested) ---------------------------------------------------

/** Percentile bootstrap CI of a proportion, deterministic seed. */
export function bootstrapCI(hits: boolean[], iters = 2000, seed = 11): [number, number] {
  if (!hits.length) return [0, 0];
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    let k = 0;
    for (let j = 0; j < hits.length; j++) if (hits[Math.floor(rnd() * hits.length)]) k++;
    stats.push(k / hits.length);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * iters)]!, stats[Math.min(iters - 1, Math.ceil(0.975 * iters) - 1)]!];
}

/** Exact two-sided McNemar test on discordant pairs: b = A caught and B missed, c = the reverse. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * p);
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// SEVERITY_ORDER is most severe first.
export const atLeast = (s: Severity, min: Severity) => SEVERITY_ORDER.indexOf(s) <= SEVERITY_ORDER.indexOf(min);

// ---- metrics -----------------------------------------------------------------

/** Latest judgement per (case, arm, finding): a model judgement overrides the rule's "ambiguous" hand-off. */
export function latestJudgements(all: Judgement[]): Map<string, Judgement[]> {
  const byFinding = new Map<string, Judgement>();
  for (const j of all) byFinding.set(`${j.case_id}|${j.arm}|${j.finding_id}`, j);
  const out = new Map<string, Judgement[]>();
  for (const j of byFinding.values()) {
    const k = `${j.case_id}|${j.arm}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(j);
  }
  return out;
}

export interface ArmMetrics {
  arm: Arm;
  runs: number;
  buggy_runs: number;
  clean_runs: number;
  caught: number;
  recall: number;
  recall_ci95: [number, number];
  judge_pending_runs: number;
  fp_per_clean_case: number;
  clean_cases_with_fp: number;
  unmatched_per_buggy_case: number;
  mean_tokens_per_case: number;
  mean_cost_per_case_usd: number;
  cost_per_bug_caught_usd: number | null;
  mean_calls_per_case: number;
  latency_p50_s: number;
  latency_p90_s: number;
  escalation_rate: number | null;
}

export interface Results {
  split: string;
  config_hash: string[];
  arms: ArmMetrics[];
  mcnemar_tierview_vs_all_opus: { both: number; tierview_only: number; opus_only: number; neither: number; p: number } | null;
  routing_recall: { faulty_at_tier2plus: number; buggy_cases: number; missed_bugs_routed_low: number | null };
  all_fable_calculated: { receipt_estimate_mean_usd: number | null; all_opus_tokens_at_fable_prices_mean_usd: number | null; note: string };
  estimator_error_vs_all_opus: { mean_abs_pct: number | null; cases: number };
}

export function computeMetrics(cases: { c: BenchCase; diff: string }[], runs: Map<string, RunFile>, judgements: Map<string, Judgement[]>, cfg: Config, split: string): Results {
  const prices = loadPrices();
  const est = loadEstimates();
  const get = (id: string, arm: Arm) => runs.get(`${id}|${arm}`);
  const caughtBy = (id: string, arm: Arm) => (judgements.get(`${id}|${arm}`) ?? []).some((j) => j.verdict === "match");
  const arms: ArmMetrics[] = ARMS.map((arm) => {
    const done = cases.filter((x) => get(x.c.id, arm)?.complete);
    const buggy = done.filter((x) => x.c.kind === "buggy");
    const clean = done.filter((x) => x.c.kind === "clean");
    const hits = buggy.map((x) => caughtBy(x.c.id, arm));
    const caught = hits.filter(Boolean).length;
    const rs = done.map((x) => get(x.c.id, arm)!);
    const tokens = rs.map((r) => r.review.receipt.tiers.reduce((a, t) => a + t.input_tokens + t.cache_write_tokens + t.cache_read_tokens + t.output_tokens, 0));
    const costs = rs.map((r) => r.review.receipt.total_cost_usd);
    const fps = clean.map((x) => get(x.c.id, arm)!.review.findings.filter((f) => atLeast(f.severity, "medium")).length);
    const unmatched = buggy.map((x) => (judgements.get(`${x.c.id}|${arm}`) ?? []).filter((j) => j.verdict === "no_match").length);
    let esc: number | null = null;
    if (arm === "tierview" && rs.length) {
      const reviewed = rs.reduce((a, r) => a + r.review.routing.filter((h) => h.tier !== 0).length, 0);
      const up = rs.reduce((a, r) => a + r.review.receipt.tiers.reduce((b, t) => b + t.escalated_in, 0), 0);
      esc = reviewed ? up / reviewed : 0;
    }
    return {
      arm,
      runs: done.length,
      buggy_runs: buggy.length,
      clean_runs: clean.length,
      caught,
      recall: buggy.length ? caught / buggy.length : 0,
      recall_ci95: bootstrapCI(hits),
      judge_pending_runs: buggy.filter((x) => get(x.c.id, arm)!.judge_pending.length).length,
      fp_per_clean_case: mean(fps),
      clean_cases_with_fp: fps.filter((n) => n > 0).length,
      unmatched_per_buggy_case: mean(unmatched),
      mean_tokens_per_case: mean(tokens),
      mean_cost_per_case_usd: mean(costs),
      cost_per_bug_caught_usd: caught ? costs.filter((_, i) => done[i]!.c.kind === "buggy").reduce((a, b) => a + b, 0) / caught : null,
      mean_calls_per_case: mean(rs.map((r) => r.calls)),
      latency_p50_s: percentile(rs.map((r) => r.wall_ms / 1000), 50),
      latency_p90_s: percentile(rs.map((r) => r.wall_ms / 1000), 90),
      escalation_rate: esc,
    };
  });

  // McNemar on buggy cases both arms completed.
  const paired = cases.filter((x) => x.c.kind === "buggy" && get(x.c.id, "tierview")?.complete && get(x.c.id, "all-opus")?.complete);
  let mc: Results["mcnemar_tierview_vs_all_opus"] = null;
  if (paired.length) {
    const t = paired.map((x) => caughtBy(x.c.id, "tierview"));
    const o = paired.map((x) => caughtBy(x.c.id, "all-opus"));
    const b = t.filter((v, i) => v && !o[i]).length;
    const c = t.filter((v, i) => !v && o[i]).length;
    mc = { both: t.filter((v, i) => v && o[i]).length, tierview_only: b, opus_only: c, neither: t.filter((v, i) => !v && !o[i]).length, p: mcnemarExact(b, c) };
  }

  // Routing recall (Tier 0 only, no calls) with the tierview arm's config.
  const tv = armPreset("tierview", cfg).cfg;
  const buggyCases = cases.filter((x) => x.c.kind === "buggy");
  const low = new Set<string>();
  let high = 0;
  for (const x of buggyCases) {
    const fh = faultyHunks(routeDiff(parseDiff(x.diff), tv, null), x.c.faulty);
    if (fh.some((h) => h.tier >= 2)) high++;
    else low.add(x.c.id);
  }
  const missedLow = buggyCases.filter((x) => get(x.c.id, "tierview")?.complete).filter((x) => low.has(x.c.id) && !caughtBy(x.c.id, "tierview")).length;

  // Calculated all-Fable cost, two ways (PLAN §9). The baseline model is receipt.baseline (Fable 5.2).
  const fable = cfg.receipt.baseline.model;
  const receiptEst = cases.map((x) => get(x.c.id, "tierview")).filter((r): r is RunFile => !!r?.complete).map((r) => r.review.receipt.baseline.cost_usd);
  const opusRuns = cases.map((x) => get(x.c.id, "all-opus")).filter((r): r is RunFile => !!r?.complete);
  const atFable = opusRuns.map((r) =>
    r.review.receipt.tiers.reduce((a, t) => a + costOf({ input_tokens: t.input_tokens, cache_creation_input_tokens: t.cache_write_tokens, cache_read_input_tokens: t.cache_read_tokens, output_tokens: t.output_tokens } as Usage, fable, prices), 0),
  );

  // Receipt estimator vs measured all-Opus: the estimator run with Opus/medium as the baseline model.
  const opusCfg: Config = { ...cfg, receipt: { baseline: { model: cfg.models.tier2.model, effort: "medium" } } };
  const errs: number[] = [];
  for (const x of cases) {
    const r = get(x.c.id, "all-opus");
    if (!r?.complete || r.review.receipt.total_cost_usd <= 0) continue;
    const routed = routeDiff(parseDiff(x.diff), cfg, null);
    const e = estimateBaseline(routed, opusCfg, prices, est).cost_usd;
    errs.push(Math.abs(e - r.review.receipt.total_cost_usd) / r.review.receipt.total_cost_usd);
  }

  return {
    split,
    config_hash: [...new Set([...runs.values()].map((r) => r.config_hash))],
    arms,
    mcnemar_tierview_vs_all_opus: mc,
    routing_recall: { faulty_at_tier2plus: high, buggy_cases: buggyCases.length, missed_bugs_routed_low: missedLow },
    all_fable_calculated: {
      receipt_estimate_mean_usd: receiptEst.length ? mean(receiptEst) : null,
      all_opus_tokens_at_fable_prices_mean_usd: atFable.length ? mean(atFable) : null,
      note: "Calculated, not measured: no Fable calls were made (PLAN §9).",
    },
    estimator_error_vs_all_opus: { mean_abs_pct: errs.length ? mean(errs) * 100 : null, cases: errs.length },
  };
}

export function table(r: Results): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(4)}`);
  const lines = [
    `| arm | runs | recall (95% CI) | FP / clean case | clean cases with FP | unmatched / buggy | tokens / case | API-eq $ / case | $ / bug caught | calls / case | p50 / p90 s |`,
    `|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|`,
    ...r.arms.map((a) => `| ${a.arm} | ${a.runs} | ${a.caught}/${a.buggy_runs} = ${pct(a.recall)} (${pct(a.recall_ci95[0])}–${pct(a.recall_ci95[1])})${a.judge_pending_runs ? ` [${a.judge_pending_runs} pending]` : ""} | ${a.fp_per_clean_case.toFixed(2)} | ${a.clean_cases_with_fp}/${a.clean_runs} | ${a.unmatched_per_buggy_case.toFixed(2)} | ${Math.round(a.mean_tokens_per_case)} | ${usd(a.mean_cost_per_case_usd)} | ${usd(a.cost_per_bug_caught_usd)} | ${a.mean_calls_per_case.toFixed(1)} | ${a.latency_p50_s.toFixed(0)} / ${a.latency_p90_s.toFixed(0)} |`),
  ];
  return lines.join("\n");
}

function main(): void {
  const i = process.argv.indexOf("--split");
  const split = i >= 0 ? process.argv[i + 1]! : "test";
  const cfg = loadConfig({ cwd: BENCH });
  const resultsDir = join(BENCH, "results");
  const cases = loadCases().filter((x) => split === "all" || x.c.split === split);
  const runs = new Map<string, RunFile>();
  for (const x of cases) for (const arm of ARMS) {
    const r = readRun(resultsDir, x.c.id, arm);
    if (r) runs.set(`${x.c.id}|${arm}`, r);
  }
  const jf = join(resultsDir, "judgements.jsonl");
  const js = existsSync(jf) ? readFileSync(jf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Judgement) : [];
  const res = computeMetrics(cases, runs, latestJudgements(js), cfg, split);
  writeFileSync(join(resultsDir, `results-${split}.json`), JSON.stringify(res, null, 2) + "\n");
  console.log(table(res));
  console.log(`\nrouting recall: ${res.routing_recall.faulty_at_tier2plus}/${res.routing_recall.buggy_cases}; McNemar tierview vs all-opus: ${JSON.stringify(res.mcnemar_tierview_vs_all_opus)}`);
  console.log(`all-Fable (calculated): receipt estimate ${res.all_fable_calculated.receipt_estimate_mean_usd?.toFixed(4) ?? "n/a"}, all-opus tokens at Fable prices ${res.all_fable_calculated.all_opus_tokens_at_fable_prices_mean_usd?.toFixed(4) ?? "n/a"} per case`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/metrics.js")) main();
