// P4-10 / P4-11: chart and audit helpers. No model calls.
import { describe, expect, it } from "vitest";
import { STRATA, csvCell, parseCsv } from "../bench/audit";
import { chartSvg } from "../bench/chart";
import type { Results } from "../bench/metrics";

const arm = (name: string, caught: number, cost: number) => ({
  arm: name, runs: 20, buggy_runs: 13, clean_runs: 7, caught, recall: caught / 13, recall_ci95: [0.2, 0.9] as [number, number], judge_pending_runs: 0,
  fp_per_clean_case: 0, clean_cases_with_fp: 0, unmatched_per_buggy_case: 0, mean_tokens_per_case: 1, mean_calls_per_case: 1,
  mean_cost_via_claude_code_usd: cost, mean_cost_direct_api_usd: cost / 2, cost_per_bug_caught_via_claude_code_usd: 1, cost_per_bug_caught_direct_api_usd: 1,
  mean_fable_priced_via_claude_code_usd: 1, mean_fable_priced_direct_api_usd: 1, latency_p50_s: 1, latency_p90_s: 1, escalation_rate: null,
});

describe("chart", () => {
  it("draws one labelled point with a range per arm, in light and dark", () => {
    const r = { split: "test", config_hash: [], arms: [arm("tierview", 9, 0.213), arm("all-sonnet", 4, 0.113), arm("all-opus", 7, 0.254), arm("tierview@v3", 3, 0.1)], mcnemar_tierview_vs_all_opus: { both: 7, tierview_only: 2, opus_only: 0, neither: 4, p: 0.5 } } as unknown as Results;
    const svg = chartSvg(r);
    expect(svg.match(/<circle /g)).toHaveLength(3); // older versions are not plotted
    for (const label of ["tierview", "all-Sonnet", "all-Opus", "9/13", "p = 0.5"]) expect(svg).toContain(label);
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(svg).toMatch(/<desc id="d">tierview: 9 of 13 bugs/);
  });
});

describe("audit file", () => {
  it("draws 20 judgements across the decision kinds, and its CSV round-trips", () => {
    expect(STRATA.reduce((a, s) => a + s.n, 0)).toBe(20);
    const row = ["a", 'say "hi", then\nleave', ""].map(csvCell).join(",");
    expect(parseCsv(`${row}\n`)).toEqual([["a", 'say "hi", then leave', ""]]);
  });
});

describe("signal report", () => {
  it("finds where a category fires and how it moves tiers (dev split, no calls)", async () => {
    const { summarise, withWeight } = await import("../bench/signal-report");
    const { loadConfig } = await import("../src/config");
    const base = loadConfig({ cwd: "bench" });
    // boundary fires on the dev bnxt bug's faulty hunk and lifts it to Opus at its configured weight
    const b = summarise(base, "boundary", base.categories.boundary!.weight, "dev");
    const bnxt = b.fires.find((f) => f.caseId === "dpdk-bnxt-short-bd-checksum")!;
    expect(bnxt).toMatchObject({ faulty: true, tierAt0: 1 });
    expect(bnxt.tierAtW).toBeGreaterThanOrEqual(2);
    // resilience_limits matches no changed line in the dev split, so its weight cannot move routing there
    const r = summarise(base, "resilience_limits", 25, "dev");
    expect(r.s.firesOn.hunks).toBe(0);
    expect(summarise(base, "resilience_limits", 0, "dev").s).toMatchObject({ faultyHigh: r.s.faultyHigh, toOpus: r.s.toOpus });
    expect(() => withWeight(base, "nope", 1)).toThrow(/unknown category/);
  });
});
