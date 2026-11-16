// P4-04 to P4-07: arms, judge, runner (fake backend and fake judge only), metrics. No claude process, no API.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { armPreset, parseArms } from "../bench/arms";
import { type Judgement, JudgeResponse, auditSample, classify, judgeUserMessage, modelJudgements, ruleJudge } from "../bench/judge";
import { atLeast, bootstrapCI, computeMetrics, judgementsFor, labelOf, loadRuns, mcnemarExact, percentile, runCosts } from "../bench/metrics";
import { faultyHunks, loadCases } from "../bench/routing";
import { BATCH_CAP, type Deps, type RunFile, readRun, runBatch, selectCases } from "../bench/run";
import { loadEstimates } from "../src/estimate";
import { loadPrices } from "../src/prices";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import type { Finding } from "../src/types";
import { FakeBackend, finding } from "./fake-client";
import { cfg } from "./helpers";

const cases = loadCases();
const byId = (id: string) => cases.find((x) => x.c.id === id)!;
const NTB = byId("dpdk-ntb-window-bound");
const NTB_FILE = NTB.c.faulty[0]!.file;
const NTB_LINE = NTB.c.faulty[0]!.lines[0]!;

const asFinding = (over: Partial<Finding>): Finding => ({
  ...finding(NTB_FILE, NTB_LINE),
  id: "F-1",
  hunk_id: `${NTB_FILE}#1`,
  model: "m",
  tier: 3,
  escalated_from: [],
  also_reported_by: [],
  ...over,
}) as Finding;

describe("arms", () => {
  it("tierview runs Tier 3 on the Tier 2 model (no Fable); baselines put every hunk on one model at Tier 3", () => {
    const tv = armPreset("tierview", cfg);
    expect(tv.cfg.models.tier3.model).toBe(cfg.models.tier2.model);
    expect(tv.substitutions).toHaveLength(1);
    for (const [arm, model, effort] of [["all-sonnet", cfg.models.tier1.model, "low"], ["all-opus", cfg.models.tier2.model, "medium"]] as const) {
      const p = armPreset(arm, cfg);
      expect(p.cfg.models.tier3).toEqual({ model, effort });
      const routed = routeDiff(parseDiff(NTB.diff), p.cfg, null);
      expect(routed.every((h) => h.tier === 3 || h.tier === 0)).toBe(true);
    }
    for (const arm of ["tierview", "all-sonnet", "all-opus"] as const) {
      const m = armPreset(arm, cfg).cfg.models;
      expect([m.tier1, m.tier2, m.tier3].some((x) => /fable/i.test(x.model))).toBe(false);
    }
    expect(() => parseArms("all-fable")).toThrow(/unknown arm/);
  });
});

describe("judge", () => {
  const hunks = parseDiff(NTB.diff);

  it("classifies by location: match within 3 lines, ambiguous inside the faulty hunk or within 10, else no match", () => {
    expect(classify({ file: NTB_FILE, start_line: NTB_LINE + 2, end_line: NTB_LINE + 2, side: "new" }, NTB.c, hunks).cls).toBe("match");
    expect(classify({ file: NTB_FILE, start_line: NTB_LINE + 7, end_line: NTB_LINE + 8, side: "new" }, NTB.c, hunks).cls).toBe("ambiguous");
    expect(classify({ file: NTB_FILE, start_line: NTB_LINE + 500, end_line: NTB_LINE + 500, side: "new" }, NTB.c, hunks).cls).toBe("no_match");
    expect(classify({ file: "other.c", start_line: NTB_LINE, end_line: NTB_LINE, side: "new" }, NTB.c, hunks).cls).toBe("no_match");
    const fh = faultyHunks(hunks, NTB.c.faulty)[0]!;
    expect(classify({ file: NTB_FILE, start_line: fh.oldStart, end_line: fh.oldStart, side: "old" }, NTB.c, hunks).cls).toBe(fh.oldLines ? "ambiguous" : "no_match");
  });

  it("hands only ambiguous findings to the model, blind to arm and model", () => {
    const fs = [asFinding({ id: "a" }), asFinding({ id: "b", start_line: NTB_LINE + 7, end_line: NTB_LINE + 7, model: "claude-opus-5-5" })];
    const r = ruleJudge(NTB.c, "tierview", fs, hunks);
    expect(r.judged.map((j) => [j.finding_id, j.method, j.verdict])).toEqual([["a", "rule", "match"]]);
    expect(r.ambiguous.map((a) => a.finding.id)).toEqual(["b"]);
    const msg = judgeUserMessage(NTB.c, "FIXDIFF", r.ambiguous);
    expect(msg).toContain("FIXDIFF");
    expect(msg).toContain("## F1");
    expect(msg).not.toMatch(/tierview|opus|sonnet|claude-/i);
    const js = modelJudgements(NTB.c, "tierview", r.ambiguous, { judgements: [{ finding: "F1", same_defect: true, confidence: 0.9, reason: "same bound" }] }, "opus");
    expect(js[0]).toMatchObject({ method: "model", verdict: "match", finding_id: "b" });
    expect(modelJudgements(NTB.c, "tierview", r.ambiguous, { judgements: [] }, "opus")).toEqual([null]);
    expect(auditSample([1, 2, 3, 4, 5], 3)).toHaveLength(3);
  });
});

/** Fake reviewer: reports a finding `offset` lines from each faulty line of its hunks. */
function fakeFor(offset: number, opts: { fail?: string } = {}) {
  return () =>
    new FakeBackend((req) => {
      if (opts.fail) return { fail: "error" };
      const out: Record<string, { verdict: "issues"; findings: ReturnType<typeof finding>[] }> = {};
      for (const { c, diff } of cases) {
        for (const h of faultyHunks(parseDiff(diff), c.faulty)) {
          if (!req.hunkIds.includes(h.id) || !req.user.includes(c.faulty[0]!.file)) continue;
          const line = c.faulty.find((f) => f.file === h.file)!.lines[0]! + offset;
          out[h.id] = { verdict: "issues", findings: [finding(h.file, Math.min(line, h.newStart + h.newLines - 1), { severity: "high", confidence: 0.95 })] };
        }
      }
      return out;
    }, "claude-code", 1);
}

function deps(dir: string, backend: () => FakeBackend, judgeCalls: string[] = [], judgeError?: string): Deps & { backends: FakeBackend[] } {
  const backends: FakeBackend[] = [];
  return {
    backends,
    cfg,
    prices: loadPrices(),
    est: loadEstimates(),
    backend: () => {
      const b = backend();
      backends.push(b);
      return b;
    },
    judge: async (_s, user) => {
      judgeCalls.push(user);
      if (judgeError) return { ok: false, value: null, error: judgeError, model: "j", usageByModel: {}, calls: 1 };
      const n = (user.match(/^## F\d+/gm) ?? []).length;
      const value = JudgeResponse.parse({ judgements: Array.from({ length: n }, (_, i) => ({ finding: `F${i + 1}`, same_defect: true, confidence: 0.8, reason: "same" })) });
      return { ok: true, value, error: null, model: "j", usageByModel: {}, calls: 1 };
    },
    files: () => () => null,
    fixDiff: () => "FIX",
    resultsDir: dir,
    now: () => new Date("2026-11-16T12:00:00Z"),
    clock: () => 0,
    log: () => {},
  };
}

describe("runner", () => {
  it("refuses a cap above 20 and plans the pilot within the cap on a dry run, with zero calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    const d = deps(dir, fakeFor(0));
    await expect(runBatch({ cases: "pilot", arms: ["tierview"], maxCalls: BATCH_CAP + 1 }, d)).rejects.toThrow(/1\.\.20/);
    const r = await runBatch({ cases: "pilot", arms: ["tierview", "all-sonnet", "all-opus"], maxCalls: 20, dryRun: true }, d);
    expect(r.calls).toBeLessThanOrEqual(20);
    expect(d.backends).toHaveLength(0);
    expect(existsSync(join(dir, "usage.jsonl"))).toBe(false);
    expect(selectCases(cases, "pilot")).toHaveLength(5);
  });

  it("runs, logs usage and rule judgements, never exceeds the cap, never asks for Fable, and resumes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    const d = deps(dir, fakeFor(0));
    const r1 = await runBatch({ cases: "pilot", arms: ["tierview", "all-sonnet", "all-opus"], maxCalls: 8 }, d);
    expect(r1.calls).toBeLessThanOrEqual(8);
    expect(r1.runs.length).toBeGreaterThan(0);
    expect(r1.stopped).toMatch(/needs about|cap/);
    expect(d.backends.flatMap((b) => b.requests).some((q) => /fable/i.test(q.model) || /fable/i.test(q.fallbackModel ?? ""))).toBe(false);
    const usage = readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(usage).toHaveLength(r1.runs.length);
    expect(usage[0]).toMatchObject({ batch: r1.batch, kind: "review", case_id: r1.runs[0]!.case_id });
    const first = readRun(dir, r1.runs[0]!.case_id, r1.runs[0]!.arm)!;
    expect(first.complete).toBe(true);
    const judged = readFileSync(join(dir, "judgements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Judgement);
    expect(judged.every((j) => j.method === "rule")).toBe(true);
    expect(judged.some((j) => j.verdict === "match")).toBe(true);

    const r2 = await runBatch({ cases: "pilot", arms: ["tierview", "all-sonnet", "all-opus"], maxCalls: 20 }, d);
    const again = r2.runs.filter((x) => r1.runs.some((y) => y.case_id === x.case_id && y.arm === x.arm));
    expect(again).toEqual([]);
  });

  it("calls the Opus judge only for ambiguous findings and logs model judgements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    const calls: string[] = [];
    const r = await runBatch({ cases: "dpdk-ntb-window-bound", arms: ["all-opus"], maxCalls: 5 }, deps(dir, fakeFor(6), calls));
    expect(r.judgeCalls).toBe(1);
    expect(calls).toHaveLength(1);
    const js = readFileSync(join(dir, "judgements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Judgement);
    expect(js.some((j) => j.method === "model" && j.verdict === "match")).toBe(true);
    expect(readRun(dir, "dpdk-ntb-window-bound", "all-opus")!.judge_pending).toEqual([]);
    expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).toContain('"kind":"judge"');
  });

  it("stops the batch on a usage-limit error and keeps the run for later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    const failing = () =>
      new (class extends FakeBackend {
        override async review(req: Parameters<FakeBackend["review"]>[0]) {
          const r = await super.review(req);
          return { ...r, ok: false as const, reason: "error" as const, detail: "Claude AI usage limit reached|1763300000" };
        }
      })(() => ({}), "claude-code", 1);
    const r = await runBatch({ cases: "pilot", arms: ["all-opus"], maxCalls: 20 }, deps(dir, failing));
    expect(r.stopped).toMatch(/usage limit/);
    expect(r.runs).toHaveLength(1);
    expect(readRun(dir, r.runs[0]!.case_id, "all-opus")!.complete).toBe(false);
  });
});

describe("metrics", () => {
  it("statistics", () => {
    expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
    const [lo, hi] = bootstrapCI([true, true, false, false, true, false, true, false, true, true]);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.6);
    expect(bootstrapCI([true, true])).toEqual([1, 1]);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(atLeast("high", "medium")).toBe(true);
    expect(atLeast("low", "medium")).toBe(false);
  });

  it("computes recall, false positives and McNemar from saved runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    await runBatch({ cases: "dpdk-ntb-window-bound,nextjs-clean-default-export-errors", arms: ["tierview", "all-opus"], maxCalls: 20 }, deps(dir, fakeFor(0)));
    const sel = selectCases(cases, "dpdk-ntb-window-bound,nextjs-clean-default-export-errors");
    const runs = loadRuns(dir);
    const js = readFileSync(join(dir, "judgements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Judgement);
    const res = computeMetrics(sel, runs, js, cfg, "test");
    const tv = res.arms.find((a) => a.arm === "tierview")!;
    expect(tv).toMatchObject({ buggy_runs: 1, clean_runs: 1, caught: 1, recall: 1, fp_per_clean_case: 0 });
    // Both cost views and the same-tokens-at-Fable-rates figure come from the receipt's own functions.
    const r = readRun(dir, "dpdk-ntb-window-bound", "tierview")!;
    const v = runCosts(r, cfg, loadPrices(), loadEstimates());
    expect(v.actual_usd).toBeCloseTo(r.review.receipt.total_cost_usd, 10);
    expect(v.direct_api_usd).toBeCloseTo(r.review.receipt.total_direct_api_cost_usd, 10);
    expect(v.baseline_usd).toBeCloseTo(r.review.receipt.baseline.cost_usd, 10);
    expect(v.direct_api_usd).toBeLessThan(v.actual_usd);
    expect(res.all_fable_calculated.via_claude_code_mean_usd).toBeCloseTo(res.arms.find((a) => a.arm === "all-opus")!.mean_fable_priced_via_claude_code_usd, 10);
    expect(res.mcnemar_tierview_vs_all_opus).toMatchObject({ both: 1, p: 1 });
    expect(res.arms.find((a) => a.arm === "all-sonnet")!.runs).toBe(0);
    expect(res.all_fable_calculated.note).toMatch(/no Fable calls/i);
  });
});

describe("pipeline v2 in the benchmark", () => {
  it("tierview makes one Sonnet call and one Opus call per case (Tier 2 merged into Tier 3, whole-diff escalation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    const d = deps(dir, fakeFor(0));
    await runBatch({ cases: "dpdk-ntb-window-bound", arms: ["tierview"], maxCalls: 20 }, d);
    const reqs = d.backends.flatMap((b) => b.requests);
    expect(reqs.map((q) => q.tier)).toEqual([1, 3]);
    expect(reqs[1]!.model).toBe(cfg.models.tier2.model);
    expect(reqs[1]!.effort).toBe("high");
    const r = readRun(dir, "dpdk-ntb-window-bound", "tierview")!;
    expect(r.arm_version).toBe(2);
    expect(r.review.receipt.tiers[1]!.requests).toBe(0);
    expect(r.review.receipt.baseline.method).toBe("actual_tokens_at_baseline_prices");
  });

  it("treats tierview runs of an older version as stale: re-runs them and archives the old file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-bench-"));
    const d = deps(dir, fakeFor(0));
    await runBatch({ cases: "dpdk-ntb-window-bound", arms: ["tierview", "all-opus"], maxCalls: 20 }, d);
    const p = join(dir, "runs", "dpdk-ntb-window-bound__tierview.json");
    const old = JSON.parse(readFileSync(p, "utf8")) as RunFile;
    writeFileSync(p, JSON.stringify({ ...old, arm_version: undefined, batch: "old-batch" }));
    expect(labelOf({ arm: "tierview" })).toBe("tierview@v1");
    const r2 = await runBatch({ cases: "dpdk-ntb-window-bound", arms: ["tierview", "all-opus"], maxCalls: 20 }, d);
    expect(r2.runs.map((x) => x.arm)).toEqual(["tierview"]);
    const runs = loadRuns(dir);
    expect(runs.has("dpdk-ntb-window-bound|tierview")).toBe(true);
    expect(runs.has("dpdk-ntb-window-bound|tierview@v1")).toBe(true);
    // Judgements count only for the run they judged.
    const js = readFileSync(join(dir, "judgements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Judgement);
    expect(judgementsFor(js, runs.get("dpdk-ntb-window-bound|tierview@v1")!)).toEqual([]);
    expect(judgementsFor(js, runs.get("dpdk-ntb-window-bound|tierview")!).length).toBeGreaterThan(0);
  });
});
