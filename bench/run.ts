// P4-05: resumable benchmark runner, in batches of at most 20 `claude` calls (review and judge calls together).
// Spec: PLAN.md §9 (Usage control). Mohamed starts every batch; nothing here runs on its own.
//
//   node .bench-build/run.js --cases pilot [--arms tierview,all-sonnet,all-opus] [--max-calls 20] [--dry-run]
//
// Per (case, arm): bench/results/runs/<case>__<arm>.json (the Review, kept); one line per run and per judge call in
// bench/results/usage.jsonl; every judgement in bench/results/judgements.jsonl. Finished pairs are never re-run.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { type Estimates, estimateTokens, loadEstimates } from "../src/estimate";
import type { FileSource } from "../src/git";
import type { ModelUsage, ReviewBackend } from "../src/llm/backend";
import { hunkBlock } from "../src/llm/prompts";
import { runPipeline } from "../src/pipeline";
import { type Prices, costOfModels, loadPrices } from "../src/prices";
import { configPath } from "../src/root";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import { limitsFor, packHunks } from "../src/tiers/batch";
import { collapseTiers } from "../src/tiers/collapse";
import type { LlmTier, Review, ScoredHunk } from "../src/types";
import { ARM_VERSION, type Arm, armPreset, parseArms } from "./arms";
import { JUDGE_SYSTEM, JUDGE_VERSION, type Judgement, JudgeResponse, judgeConfig, judgeUserMessage, modelJudgements, ruleJudge } from "./judge";
import { loadCases } from "./routing";
import type { BenchCase } from "./validate";
import { BENCH } from "./lib/sh";

/** Mohamed's limit: at most 20 claude calls per batch. */
export const BATCH_CAP = 20;
/** Errors that mean "stop the batch now": plan usage or rate limits. */
export const LIMIT_ERROR = /usage limit|rate.?limit|limit reached|too many requests|\b429\b|overloaded|quota|credit balance/i;

export interface RunFile {
  case_id: string;
  arm: Arm;
  /** ARM_VERSION of the arm when it ran; missing = 1. */
  arm_version?: number;
  batch: string;
  config_hash: string;
  complete: boolean;
  /** Why the run is incomplete (budget cap or a usage-limit error). */
  stopped?: string;
  calls: number;
  wall_ms: number;
  review: Review;
  /** Buggy cases: findings still waiting for the model judge. */
  judge_pending: string[];
}

export interface UsageLine {
  at: string;
  batch: string;
  case_id: string;
  arm: string;
  kind: "review" | "judge";
  calls: number;
  tokens: Record<string, { input: number; cache_write: number; cache_read: number; output: number }>;
  /** Via Claude Code (API-equivalent). */
  api_equivalent_usd: number;
  /** The same run without Claude Code's per-call overhead. */
  direct_api_usd: number;
  wall_ms: number;
  substitutions: string[];
  complete: boolean;
}

export interface JudgeCall {
  (system: string, user: string): Promise<{ ok: boolean; value: JudgeResponse | null; error: string | null; model: string; usageByModel: Record<string, ModelUsage>; calls: number }>;
}

export interface Deps {
  cfg: Config;
  prices: Prices;
  est: Estimates;
  /** A fresh backend per run (claude-code; tests pass a fake). */
  backend: () => ReviewBackend;
  judge: JudgeCall;
  /** File contents at the case's commit (Tier 2/3 context). */
  files: (c: BenchCase) => FileSource;
  fixDiff: (c: BenchCase) => string;
  resultsDir: string;
  now?: () => Date;
  clock?: () => number;
  log?: (s: string) => void;
}

export interface BatchOptions {
  cases: string;
  arms: Arm[];
  maxCalls: number;
  dryRun?: boolean;
  batch?: string;
}

export function configHash(): string {
  const h = createHash("sha256");
  for (const f of ["default-rules.yml", "prices.json", "estimates.json"]) h.update(readFileSync(configPath(f)));
  // The judge is frozen with the config (bench-config-v1): its rules, stopwords, prompt and version.
  h.update(judgeConfig());
  return h.digest("hex").slice(0, 12);
}

export interface RejudgeReport {
  runs: number;
  findings: number;
  ruleMatch: number;
  ruleNoMatch: number;
  ambiguous: number;
  reusedModel: number;
  pending: number;
  /** Opus calls the pending findings need: one per run with pending findings. */
  opusCallsNeeded: number;
}

/**
 * Re-judges saved runs (runs/ and runs-archive/) under the current JUDGE_VERSION from their saved findings, with no
 * model calls. An ambiguous finding reuses an earlier model verdict on the same finding of the same run when one
 * exists (same prompt); otherwise it is left pending for the next batch's judge step.
 */
export function rejudge(resultsDir: string, which: string, at: string): RejudgeReport {
  const cases = new Map(selectCases(loadCases(), which).map((x) => [x.c.id, x]));
  const jf = join(resultsDir, "judgements.jsonl");
  const old = existsSync(jf) ? readFileSync(jf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Judgement) : [];
  const rep: RejudgeReport = { runs: 0, findings: 0, ruleMatch: 0, ruleNoMatch: 0, ambiguous: 0, reusedModel: 0, pending: 0, opusCallsNeeded: 0 };
  for (const sub of ["runs", "runs-archive"]) {
    const dir = join(resultsDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as RunFile;
      const x = cases.get(r.case_id);
      if (!x || x.c.kind !== "buggy" || !r.complete) continue;
      const done = old.some((j) => j.case_id === r.case_id && j.arm === r.arm && (j.run_batch ?? j.batch) === r.batch && (j.judge_version ?? 1) === JUDGE_VERSION);
      if (done) continue;
      rep.runs++;
      const findings = [...r.review.findings, ...r.review.refuted];
      rep.findings += findings.length;
      const { judged, ambiguous } = ruleJudge(x.c, r.arm, findings, x.diff);
      const out: Judgement[] = [...judged];
      rep.ruleMatch += judged.filter((j) => j.verdict === "match").length;
      rep.ruleNoMatch += judged.filter((j) => j.verdict === "no_match").length;
      rep.ambiguous += ambiguous.length;
      const pending: string[] = [];
      for (const a of ambiguous) {
        const prev = [...old].reverse().find((j) => j.method === "model" && j.case_id === r.case_id && j.arm === r.arm && j.finding_id === a.finding.id && (j.run_batch ?? j.batch) === r.batch);
        if (prev) {
          rep.reusedModel++;
          out.push({ ...prev, judge_version: JUDGE_VERSION, reason: `${prev.reason} [reused from judge v${prev.judge_version ?? 1}: same finding, same prompt; now ambiguous because: ${a.reason}]` });
        } else pending.push(a.finding.id);
      }
      for (const j of out) appendFileSync(jf, JSON.stringify({ ...j, run_batch: r.batch, batch: `rejudge-v${JUDGE_VERSION}-${at}`, at }) + "\n");
      rep.pending += pending.length;
      if (pending.length) rep.opusCallsNeeded++;
      if (sub === "runs") {
        r.judge_pending = pending;
        writeFileSync(join(dir, f), JSON.stringify(r, null, 2) + "\n");
      }
    }
  }
  return rep;
}

export function selectCases(all: { c: BenchCase; diff: string }[], which: string): { c: BenchCase; diff: string }[] {
  if (which === "all") return all;
  if (which === "pilot") return all.filter((x) => x.c.pilot);
  if (which === "dev" || which === "test") return all.filter((x) => x.c.split === which);
  const ids = which.split(",");
  const out = all.filter((x) => ids.includes(x.c.id));
  if (out.length !== ids.length) throw new Error(`unknown case id in --cases ${which}`);
  return out;
}

/**
 * Calls a run will make without retries: one per claude-code pack per tier (after merging Tier 2 into Tier 3 when
 * they share a model), and for tierview one call for each higher tier that lower-tier escalations could reach.
 */
export function plannedCalls(routed: ScoredHunk[], arm: Arm, cfg: Config, est: Estimates): number {
  const c = collapseTiers(cfg, routed);
  let n = 0;
  let below = false;
  for (const t of [1, 2, 3] as LlmTier[]) {
    if (t === 2 && c.merged) continue;
    const hs = c.routed.filter((h) => h.tier === t);
    const packs = hs.length ? packHunks(hs, limitsFor("claude-code", t, c.cfg, est), (h) => estimateTokens(hunkBlock({ hunk: h, context: null, prior: [] }), est)).length : 0;
    n += arm === "tierview" && below ? Math.max(packs, 1) : packs;
    below ||= hs.length > 0;
  }
  return n;
}

/** A complete run of the arm's current version. */
export const isCurrent = (r: RunFile | null, arm: Arm) => !!r?.complete && (r.arm_version ?? 1) === ARM_VERSION[arm];

const runPath = (dir: string, caseId: string, arm: string) => join(dir, "runs", `${caseId}__${arm}.json`);

export function readRun(dir: string, caseId: string, arm: string): RunFile | null {
  const p = runPath(dir, caseId, arm);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunFile) : null;
}

function tokensOf(u: Record<string, ModelUsage>): UsageLine["tokens"] {
  return Object.fromEntries(Object.entries(u).map(([m, x]) => [m, { input: x.usage.input_tokens, cache_write: x.usage.cache_creation_input_tokens, cache_read: x.usage.cache_read_input_tokens, output: x.usage.output_tokens }]));
}

export interface BatchReport {
  batch: string;
  calls: number;
  runs: { case_id: string; arm: string; calls: number; complete: boolean; usd: number }[];
  judgeCalls: number;
  stopped: string | null;
  remaining: { case_id: string; arm: string; planned: number }[];
}

export async function runBatch(o: BatchOptions, d: Deps): Promise<BatchReport> {
  if (!(o.maxCalls > 0 && o.maxCalls <= BATCH_CAP)) throw new Error(`--max-calls must be 1..${BATCH_CAP} (Mohamed's per-batch limit)`);
  const now = d.now ?? (() => new Date());
  const clock = d.clock ?? (() => performance.now());
  const log = d.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const batch = o.batch ?? now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hash = configHash();
  mkdirSync(join(d.resultsDir, "runs"), { recursive: true });
  const report: BatchReport = { batch, calls: 0, runs: [], judgeCalls: 0, stopped: null, remaining: [] };
  const left = () => o.maxCalls - report.calls;
  const cases = selectCases(loadCases(), o.cases);

  const writeRun = (r: RunFile) => writeFileSync(runPath(d.resultsDir, r.case_id, r.arm), JSON.stringify(r, null, 2) + "\n");
  const usage = (u: UsageLine) => appendFileSync(join(d.resultsDir, "usage.jsonl"), JSON.stringify(u) + "\n");
  const logJudgements = (js: Judgement[], runBatch: string) => {
    for (const j of js) appendFileSync(join(d.resultsDir, "judgements.jsonl"), JSON.stringify({ ...j, run_batch: runBatch, batch, at: now().toISOString() }) + "\n");
  };

  /** Model judge for a run's pending findings. Returns false when the batch must stop. */
  const judgePending = async (c: BenchCase, diff: string, r: RunFile): Promise<boolean> => {
    if (!r.judge_pending.length) return true;
    if (left() < 1) return false;
    const all = [...r.review.findings, ...r.review.refuted];
    const items = ruleJudge(c, r.arm, all.filter((f) => r.judge_pending.includes(f.id)), diff).ambiguous;
    if (o.dryRun) {
      report.calls += 1;
      report.judgeCalls += 1;
      return true;
    }
    const t0 = clock();
    const res = await d.judge(JUDGE_SYSTEM, judgeUserMessage(c, d.fixDiff(c), items));
    report.calls += res.calls;
    report.judgeCalls += res.calls;
    const usd = costOfModels(res.usageByModel, d.prices).cost;
    usage({ at: now().toISOString(), batch, case_id: c.id, arm: `judge:${r.arm}`, kind: "judge", calls: res.calls, tokens: tokensOf(res.usageByModel), api_equivalent_usd: usd, direct_api_usd: usd, wall_ms: Math.round(clock() - t0), substitutions: [], complete: res.ok });
    if (!res.ok || !res.value) {
      log(`  judge failed for ${c.id} ${r.arm}: ${res.error}`);
      if (res.error && LIMIT_ERROR.test(res.error)) {
        report.stopped = `usage limit during judge: ${res.error.slice(0, 200)}`;
        return false;
      }
      return true; // stays pending; retried next batch
    }
    const js = modelJudgements(c, r.arm, items, res.value, res.model);
    logJudgements(js.filter((j): j is Judgement => j !== null), r.batch);
    r.judge_pending = items.filter((_, i) => js[i] === null).map((x) => x.finding.id);
    writeRun(r);
    return true;
  };

  // 1. Finish judging earlier runs first (one call each).
  for (const { c, diff } of cases) {
    for (const arm of o.arms) {
      const r = readRun(d.resultsDir, c.id, arm);
      if (r && isCurrent(r, arm) && r.judge_pending.length) {
        if (left() < 1 || !(await judgePending(c, diff, r))) {
          report.stopped ??= "batch call cap reached";
          return finish();
        }
      }
    }
  }

  // 2. New runs, case by case, all arms of a case together (so arms are compared on the same days).
  for (const { c, diff } of cases) {
    for (const arm of o.arms) {
      const prev = readRun(d.resultsDir, c.id, arm);
      if (isCurrent(prev, arm)) continue;
      const preset = armPreset(arm, d.cfg);
      const routed = routeDiff(parseDiff(diff), preset.cfg, null);
      const planned = plannedCalls(routed, arm, preset.cfg, d.est) + (c.kind === "buggy" ? 1 : 0);
      if (!report.stopped && planned > left()) report.stopped = `next run (${c.id} ${arm}) needs about ${planned} call(s); ${left()} left in this batch`;
      if (report.stopped) {
        report.remaining.push({ case_id: c.id, arm, planned });
        continue;
      }
      if (o.dryRun) {
        report.calls += planned;
        report.runs.push({ case_id: c.id, arm, calls: planned, complete: false, usd: 0 });
        continue;
      }
      if (prev) {
        // Keep the stale or incomplete run for the record; metrics reads it as an older version.
        mkdirSync(join(d.resultsDir, "runs-archive"), { recursive: true });
        renameSync(runPath(d.resultsDir, c.id, arm), join(d.resultsDir, "runs-archive", `${c.id}__${arm}__v${prev.arm_version ?? 1}__${prev.batch}.json`));
      }
      log(`run ${c.id} ${arm} (planned ${planned} call(s), ${left()} left in this batch)`);
      const t0 = clock();
      const backend = d.backend();
      const { review, budgetExhausted } = await runPipeline({
        routed,
        cfg: preset.cfg,
        backend,
        files: d.files(c),
        prices: d.prices,
        est: d.est,
        maxCost: null,
        maxCalls: left(),
        substitutions: preset.substitutions,
        warnings: ["benchmark: diff from bench/cases, file context from the commit, churn signals off."],
      });
      const wall = Math.round(clock() - t0);
      report.calls += review.receipt.calls;
      const limitHit = review.receipt.warnings.find((w) => /call failed/.test(w) && LIMIT_ERROR.test(w));
      const complete = !budgetExhausted && !limitHit;
      let pending: string[] = [];
      if (complete && c.kind === "buggy") {
        const { judged, ambiguous } = ruleJudge(c, arm, [...review.findings, ...review.refuted], diff);
        logJudgements(judged, batch);
        pending = ambiguous.map((a) => a.finding.id);
      }
      const run: RunFile = { case_id: c.id, arm, arm_version: ARM_VERSION[arm], batch, config_hash: hash, complete, stopped: limitHit ? "usage limit" : budgetExhausted ? "batch call cap" : undefined, calls: review.receipt.calls, wall_ms: wall, review, judge_pending: pending };
      writeRun(run);
      const usd = review.receipt.total_cost_usd;
      usage({
        at: now().toISOString(),
        batch,
        case_id: c.id,
        arm,
        kind: "review",
        calls: review.receipt.calls,
        tokens: Object.fromEntries(review.receipt.tiers.filter((t) => t.requests).map((t) => [`tier${t.tier}:${t.model}`, { input: t.input_tokens, cache_write: t.cache_write_tokens, cache_read: t.cache_read_tokens, output: t.output_tokens }])),
        api_equivalent_usd: usd,
        direct_api_usd: review.receipt.total_direct_api_cost_usd,
        wall_ms: wall,
        substitutions: review.receipt.model_substitutions.map((s) => `tier ${s.tier}: ${s.requested} -> ${s.used} (${s.reason})`),
        complete,
      });
      report.runs.push({ case_id: c.id, arm, calls: review.receipt.calls, complete, usd });
      if (limitHit) {
        report.stopped = `usage limit: ${limitHit.slice(0, 200)}`;
        continue;
      }
      if (!complete) {
        report.stopped = "batch call cap reached inside a run (it will be re-run)";
        continue;
      }
      if (!(await judgePending(c, diff, run))) report.stopped ??= "batch call cap reached before judging";
    }
  }
  return finish();

  function finish(): BatchReport {
    if (!o.dryRun) appendFileSync(join(d.resultsDir, "batches.jsonl"), JSON.stringify({ batch, at: now().toISOString(), cases: o.cases, arms: o.arms, calls: report.calls, judge_calls: report.judgeCalls, stopped: report.stopped, runs: report.runs }) + "\n");
    return report;
  }
}

// ---- CLI ---------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const { ClaudeCodeBackend, resolveClaudeBinary, runStructured, verifyClaudeBinary } = await import("../src/llm/claude-code");
  const { ensureClone, git } = await import("./lib/sh");
  const cfg = loadConfig({ cwd: BENCH });
  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--rejudge")) {
    // No model calls: re-judge saved findings under the current judge version.
    const r = rejudge(join(BENCH, "results"), arg("cases") ?? "all", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const o: BatchOptions = { cases: arg("cases") ?? "pilot", arms: parseArms(arg("arms")), maxCalls: Number(arg("max-calls") ?? BATCH_CAP), dryRun };
  let bin = "claude";
  if (!dryRun) {
    const b = resolveClaudeBinary({ configured: cfg.backend.claude_code.binary });
    if (!b) throw new Error("Claude Code CLI not found");
    process.stderr.write(`${await verifyClaudeBinary(b)}; batch cap ${o.maxCalls} calls; no Fable.\n`);
    bin = b;
    process.env.TIERVIEW_DEBUG_DIR ??= join(BENCH, "results", "raw");
  }
  const judgeModel = cfg.models.tier2; // Opus 5.5 (PLAN §9)
  const report = await runBatch(o, {
    cfg,
    prices: loadPrices(),
    est: loadEstimates(),
    backend: () => new ClaudeCodeBackend({ bin, timeoutMs: cfg.backend.claude_code.timeout_s * 1000, cachePath: null, allowFable: false }),
    judge: (system, user) => runStructured({ bin, model: judgeModel.model, effort: "medium", system, user, schema: JudgeResponse, timeoutMs: cfg.backend.claude_code.timeout_s * 1000 }),
    files: (c) => {
      const dir = ensureClone(c.repo);
      return (p: string) => {
        const t = git(dir, ["show", `${c.commit}:${p}`], { allowFail: true });
        return t === "" ? null : t;
      };
    },
    fixDiff: (c) => readFileSync(join(BENCH, "cases", `${c.id}.fix.diff`), "utf8"),
    resultsDir: join(BENCH, "results"),
  });
  const total = report.runs.reduce((a, r) => a + r.usd, 0);
  console.log(`${dryRun ? "DRY RUN (no calls made) " : ""}batch ${report.batch}: ${report.calls} claude call(s)${dryRun ? " planned" : ""} (${report.judgeCalls} judge), API-equivalent $${total.toFixed(4)}`);
  for (const r of report.runs) console.log(`  ${r.case_id.padEnd(38)} ${r.arm.padEnd(10)} ${r.calls} call(s)${dryRun ? "" : `  ${r.complete ? "complete" : "INCOMPLETE"}  $${r.usd.toFixed(4)}`}`);
  if (report.stopped) console.log(`stopped: ${report.stopped}`);
  if (report.remaining.length) console.log(`left for later batches: ${report.remaining.length} run(s), about ${report.remaining.reduce((a, r) => a + r.planned, 0)} call(s) without escalations or retries`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/run.js")) await main();
