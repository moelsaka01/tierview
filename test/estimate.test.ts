import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimatePlan, estimateTokens, loadEstimates } from "../src/estimate";
import { formatHunk, parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import type { ScoredHunk } from "../src/types";
import { cfg, hunk } from "./helpers";

const est = loadEstimates();
const prices = JSON.parse(readFileSync("config/prices.json", "utf8"));

describe("estimate", () => {
  it("estimates tokens as ceil(chars / 3)", () => {
    expect(estimateTokens("abcd", est)).toBe(2);
    expect(estimateTokens("", est)).toBe(0);
    expect(estimateTokens("a".repeat(300), est)).toBe(100);
  });

  it("prices one Tier 3 hunk by hand", () => {
    const [h] = routeDiff(parseDiff(readFileSync("test/fixtures/auth-login-sql.diff", "utf8")), cfg);
    const plan = estimatePlan([h as ScoredHunk], cfg, prices, est);
    const t3 = plan.tiers[2]!;
    expect(t3).toMatchObject({ tier: 3, hunks: 1, requests: 1, model: "claude-fable-5-2" });
    const hunkTokens = estimateTokens(formatHunk(h as ScoredHunk), est);
    const expectedInput = est.system_prompt_tokens + est.shared_context_tokens_per_file + est.shared_context_tokens_per_hunk + est.context_tokens_per_hunk.tier3 + hunkTokens;
    expect(t3.input_tokens).toBe(expectedInput);
    expect(t3.output_tokens).toBe(est.output_tokens_per_hunk.tier3);
    expect(t3.cost_usd).toBeCloseTo((t3.input_tokens * 8 + t3.output_tokens * 40) / 1e6, 8);
    expect(plan.baseline.cost_usd).toBeCloseTo(t3.cost_usd, 8);
    expect(plan.tiers[0]!.hunks + plan.tiers[1]!.hunks).toBe(0);
  });

  it("never sends skipped hunks and prices the baseline at Fable", () => {
    const routed = routeDiff(
      [hunk("package-lock.json", ["+x"]), hunk("src/a.ts", ["+x"]), hunk("src/auth/login.py", ["+jwt.sign(x)", "+f'select {x}'"])],
      cfg,
    );
    const plan = estimatePlan(routed, cfg, prices, est);
    expect(plan.skipped_hunks).toBe(1);
    expect(plan.tiers.reduce((a, t) => a + t.hunks, 0)).toBe(2);
    expect(plan.baseline.model).toBe("claude-fable-5-2");
    expect(plan.baseline.cost_usd).toBeGreaterThan(plan.total_usd);
    expect(plan.savings_pct).toBeGreaterThan(0);
    expect(plan.reserve_usd).toBeCloseTo(plan.total_usd * 0.15, 10);
  });

  it("packs Tier 1 by hunk count and groups Tiers 2 and 3 by file", () => {
    const many = Array.from({ length: 25 }, (_, i) => hunk(`src/f${i % 5}.ts`, ["+x"], "modified", i + 1));
    const plan = estimatePlan(routeDiff(many, cfg), cfg, prices, est);
    expect(plan.tiers[0]!.hunks).toBe(25);
    expect(plan.tiers[0]!.requests).toBe(3); // 12 + 12 + 1
    const risky = Array.from({ length: 4 }, (_, i) => hunk(`src/auth/f${i % 2}.ts`, ["+jwt.sign(x)", ...Array.from({ length: 30 }, () => "+y")], "modified", i + 1));
    const p2 = estimatePlan(routeDiff(risky, cfg), cfg, prices, est);
    expect(p2.tiers[1]!.requests + p2.tiers[2]!.requests).toBe(2);
  });

  it("is zero for an empty plan", () => {
    const plan = estimatePlan([], cfg, prices, est);
    expect(plan.total_usd).toBe(0);
    expect(plan.savings_pct).toBe(0);
  });
});
