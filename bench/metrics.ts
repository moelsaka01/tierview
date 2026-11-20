// P4-07: every metric in PLAN.md §9 from saved runs and judgements. No model calls.
//   node .bench-build/metrics.js [--split test|dev|all]   -> bench/results/results-<split>.json + a markdown table
// Costs use src/costs.ts, the same functions as the receipt: "via Claude Code" (what ran), "direct API" (without
// Claude Code's per-call overhead), and all-Fable = the same actual tokens at Fable rates.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { costViews } from "../src/costs";
import { type Estimates, loadEstimates } from "../src/estimate";
import { type Prices, loadPrices } from "../src/prices";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import { SEVERITY_ORDER, type Severity } from "../src/types";
import { ARMS, ARM_VERSION, type Arm, armPreset } from "./arms";
import { JUDGE_VERSION, type Judgement } from "./judge";
import { faultyHunks, loadCases } from "./routing";
import type { RunFile } from "./run";
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

// ---- runs and judgements -------------------------------------------------------

/** "tierview" for a run of the arm's current version, "tierview@v1" for an older one. */
export const labelOf = (r: Pick<RunFile, "arm" | "arm_version">) => ((r.arm_version ?? 1) === ARM_VERSION[r.arm] ? r.arm : `${r.arm}@v${r.arm_version ?? 1}`);

/** Complete runs from runs/ and runs-archive/, keyed "<case>|<label>" (the newest run wins per key). */
export function loadRuns(resultsDir: string): Map<string, RunFile> {
  const out = new Map<string, RunFile>();
  for (const sub of ["runs-archive", "runs"]) {
    const dir = join(resultsDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as RunFile;
      if (r.complete) out.set(`${r.case_id}|${labelOf(r)}`, r);
    }
  }
  return out;
}

/** The judgements of one run: logged for that run's batch by the current judge version, latest per finding (a model verdict overrides a rule hand-off). */
export function judgementsFor(all: Judgement[], r: Pick<RunFile, "case_id" | "arm" | "batch">): Judgement[] {
  const byFinding = new Map<string, Judgement>();
  for (const j of all) {
    if (j.case_id !== r.case_id || j.arm !== r.arm || (j.run_batch ?? j.batch) !== r.batch) continue;
    if ((j.judge_version ?? 1) !== JUDGE_VERSION) continue; // only the frozen judge counts
    byFinding.set(j.finding_id, j);
  }
  return [...byFinding.values()];
}

/** The four cost figures of a saved run, recomputed from its per-tier tokens with src/costs.ts. */
export function runCosts(r: RunFile, cfg: Config, prices: Prices, est: Estimates) {
  const backend = r.review.receipt.backend;
  return costViews(r.review.receipt.tiers, cfg.receipt.baseline.model, prices, backend, backend === "claude-code" ? est.claude_code_overhead_tokens_per_call : 0);
}

// ---- metrics -----------------------------------------------------------------

export interface ArmMetrics {
  arm: string;
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
  mean_calls_per_case: number;
  /** What ran (claude-code: API-equivalent). */
  mean_cost_via_claude_code_usd: number;
  /** The same tokens without Claude Code's per-call overhead. */
  mean_cost_direct_api_usd: number;
  cost_per_bug_caught_via_claude_code_usd: number | null;
  cost_per_bug_caught_direct_api_usd: number | null;
  /** This arm's actual tokens at Fable rates (the receipt's all-Fable method). */
  mean_fable_priced_via_claude_code_usd: number;
  mean_fable_priced_direct_api_usd: number;
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
  all_fable_calculated: { via_claude_code_mean_usd: number | null; direct_api_mean_usd: number | null; note: string };
}

export function computeMetrics(cases: { c: BenchCase; diff: string }[], runs: Map<string, RunFile>, judgements: Judgement[], cfg: Config, split: string): Results {
  const prices = loadPrices();
  const est = loadEstimates();
  const get = (id: string, label: string) => runs.get(`${id}|${label}`);
  const caughtBy = (id: string, label: string) => {
    const r = get(id, label);
    return !!r && judgementsFor(judgements, r).some((j) => j.verdict === "match");
  };
  const labels = [...ARMS, ...new Set([...runs.keys()].map((k) => k.split("|")[1]!).filter((l) => !(ARMS as readonly string[]).includes(l)))];

  const arms: ArmMetrics[] = labels.map((label) => {
    const done = cases.filter((x) => get(x.c.id, label));
    const buggy = done.filter((x) => x.c.kind === "buggy");
    const clean = done.filter((x) => x.c.kind === "clean");
    const hits = buggy.map((x) => caughtBy(x.c.id, label));
    const caught = hits.filter(Boolean).length;
    const rs = done.map((x) => get(x.c.id, label)!);
    const costs = rs.map((r) => runCosts(r, cfg, prices, est));
    const buggyIdx = done.map((x, i) => (x.c.kind === "buggy" ? i : -1)).filter((i) => i >= 0);
    const sumBuggy = (k: "actual_usd" | "direct_api_usd") => buggyIdx.reduce((a, i) => a + costs[i]![k], 0);
    const tokens = rs.map((r) => r.review.receipt.tiers.reduce((a, t) => a + t.input_tokens + t.cache_write_tokens + t.cache_read_tokens + t.output_tokens, 0));
    const fps = clean.map((x) => get(x.c.id, label)!.review.findings.filter((f) => atLeast(f.severity, "medium")).length);
    const unmatched = buggy.map((x) => judgementsFor(judgements, get(x.c.id, label)!).filter((j) => j.verdict === "no_match").length);
    let esc: number | null = null;
    if (label.startsWith("tierview") && rs.length) {
      const reviewed = rs.reduce((a, r) => a + r.review.routing.filter((h) => h.tier !== 0).length, 0);
      const up = rs.reduce((a, r) => a + r.review.receipt.tiers.reduce((b, t) => b + t.escalated_in, 0), 0);
      esc = reviewed ? up / reviewed : 0;
    }
    return {
      arm: label,
      runs: done.length,
      buggy_runs: buggy.length,
      clean_runs: clean.length,
      caught,
      recall: buggy.length ? caught / buggy.length : 0,
      recall_ci95: bootstrapCI(hits),
      judge_pending_runs: buggy.filter((x) => get(x.c.id, label)!.judge_pending.length).length,
      fp_per_clean_case: mean(fps),
      clean_cases_with_fp: fps.filter((n) => n > 0).length,
      unmatched_per_buggy_case: mean(unmatched),
      mean_tokens_per_case: mean(tokens),
      mean_calls_per_case: mean(rs.map((r) => r.calls)),
      mean_cost_via_claude_code_usd: mean(costs.map((c) => c.actual_usd)),
      mean_cost_direct_api_usd: mean(costs.map((c) => c.direct_api_usd)),
      cost_per_bug_caught_via_claude_code_usd: caught ? sumBuggy("actual_usd") / caught : null,
      cost_per_bug_caught_direct_api_usd: caught ? sumBuggy("direct_api_usd") / caught : null,
      mean_fable_priced_via_claude_code_usd: mean(costs.map((c) => c.baseline_usd)),
      mean_fable_priced_direct_api_usd: mean(costs.map((c) => c.baseline_direct_api_usd)),
      latency_p50_s: percentile(rs.map((r) => r.wall_ms / 1000), 50),
      latency_p90_s: percentile(rs.map((r) => r.wall_ms / 1000), 90),
      escalation_rate: esc,
    };
  });

  // McNemar on buggy cases both current arms completed.
  const paired = cases.filter((x) => x.c.kind === "buggy" && get(x.c.id, "tierview") && get(x.c.id, "all-opus"));
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
  const missedLow = buggyCases.filter((x) => get(x.c.id, "tierview")).filter((x) => low.has(x.c.id) && !caughtBy(x.c.id, "tierview")).length;

  // All-Fable, one method (PLAN §7): the all-opus arm (every hunk to the top model, Tier 3 shape) at Fable rates.
  const opus = arms.find((a) => a.arm === "all-opus")!;
  return {
    split,
    config_hash: [...new Set([...runs.values()].map((r) => r.config_hash))],
    arms,
    mcnemar_tierview_vs_all_opus: mc,
    routing_recall: { faulty_at_tier2plus: high, buggy_cases: buggyCases.length, missed_bugs_routed_low: missedLow },
    all_fable_calculated: {
      via_claude_code_mean_usd: opus.runs ? opus.mean_fable_priced_via_claude_code_usd : null,
      direct_api_mean_usd: opus.runs ? opus.mean_fable_priced_direct_api_usd : null,
      note: "Calculated, not measured: the all-opus arm's actual tokens priced at Fable 5.2 rates. No Fable calls were made (PLAN §9).",
    },
  };
}

export function table(r: Results): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(3)}`);
  const lines = [
    `| arm | runs | recall (95% CI) | FP / clean case | clean cases with FP | unmatched / buggy | tokens / case | calls / case | $ / case via Claude Code | $ / case direct API | $ / bug caught (CC / direct) | same tokens at Fable rates (CC / direct) | p50 / p90 s |`,
    `|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|`,
    ...r.arms.map(
      (a) =>
        `| ${a.arm} | ${a.runs} | ${a.caught}/${a.buggy_runs} = ${pct(a.recall)} (${pct(a.recall_ci95[0])}–${pct(a.recall_ci95[1])})${a.judge_pending_runs ? ` [${a.judge_pending_runs} pending]` : ""} | ${a.fp_per_clean_case.toFixed(2)} | ${a.clean_cases_with_fp}/${a.clean_runs} | ${a.unmatched_per_buggy_case.toFixed(2)} | ${Math.round(a.mean_tokens_per_case)} | ${a.mean_calls_per_case.toFixed(1)} | ${usd(a.mean_cost_via_claude_code_usd)} | ${usd(a.mean_cost_direct_api_usd)} | ${usd(a.cost_per_bug_caught_via_claude_code_usd)} / ${usd(a.cost_per_bug_caught_direct_api_usd)} | ${usd(a.mean_fable_priced_via_claude_code_usd)} / ${usd(a.mean_fable_priced_direct_api_usd)} | ${a.latency_p50_s.toFixed(0)} / ${a.latency_p90_s.toFixed(0)} |`,
    ),
  ];
  return lines.join("\n");
}

function main(): void {
  const i = process.argv.indexOf("--split");
  const split = i >= 0 ? process.argv[i + 1]! : "test";
  const cfg = loadConfig({ cwd: BENCH });
  const resultsDir = join(BENCH, "results");
  const cases = loadCases().filter((x) => split === "all" || (split === "heldout" ? x.c.split === "test" || x.c.split === "test2" : x.c.split === split));
  const ids = new Set(cases.map((x) => x.c.id));
  const runs = new Map([...loadRuns(resultsDir)].filter(([k]) => ids.has(k.split("|")[0]!)));
  const jf = join(resultsDir, "judgements.jsonl");
  const js = existsSync(jf) ? readFileSync(jf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Judgement) : [];
  const res = computeMetrics(cases, runs, js, cfg, split);
  writeFileSync(join(resultsDir, `results-${split}.json`), JSON.stringify(res, null, 2) + "\n");
  console.log(table(res));
  console.log(`\nrouting recall: ${res.routing_recall.faulty_at_tier2plus}/${res.routing_recall.buggy_cases}; McNemar tierview vs all-opus: ${JSON.stringify(res.mcnemar_tierview_vs_all_opus)}`);
  const f = res.all_fable_calculated;
  console.log(`all-Fable (calculated: all-opus tokens at Fable rates): ${f.via_claude_code_mean_usd?.toFixed(4) ?? "n/a"} via Claude Code, ${f.direct_api_mean_usd?.toFixed(4) ?? "n/a"} direct API, per case`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/metrics.js")) main();
