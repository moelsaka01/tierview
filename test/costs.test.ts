// Cost views (via Claude Code, direct API, all-Fable as the same tokens at Fable rates) and the Tier 2/3 merge.
import { describe, expect, it } from "vitest";
import { degradePlan } from "../src/budget";
import { costViews, directApiCost, priceTokens } from "../src/costs";
import { applyFablePolicy } from "../src/fable";
import { estimatePlan, loadEstimates } from "../src/estimate";
import { loadPrices } from "../src/prices";
import { collapseTiers, tiersMerged } from "../src/tiers/collapse";
import { routeDiff } from "../src/tier0/route";
import { cfg, hunk } from "./helpers";

const prices = loadPrices();
const est = loadEstimates();
const S = cfg.models.tier1.model;
const O = cfg.models.tier2.model;
const F = cfg.receipt.baseline.model;
const t = { input_tokens: 2, cache_write_tokens: 3000, cache_read_tokens: 1000, output_tokens: 400, requests: 1 };

describe("cost views", () => {
  it("prices tokens by class, with 1-hour cache writes on claude-code", () => {
    const p = prices.models[O]!;
    expect(priceTokens(t, O, prices, "claude-code")).toBeCloseTo((2 * p.input + 3000 * p.cache_write_1h! + 1000 * p.cache_read + 400 * p.output) / 1e6, 12);
    expect(priceTokens(t, O, prices, "api")).toBeCloseTo((2 * p.input + 3000 * p.cache_write_5m + 1000 * p.cache_read + 400 * p.output) / 1e6, 12);
  });

  it("direct API drops the per-call overhead and prices the rest as plain input", () => {
    const p = prices.models[O]!;
    expect(directApiCost(t, O, prices, "claude-code", 2100)).toBeCloseTo(((4002 - 2100) * p.input + 400 * p.output) / 1e6, 12);
    expect(directApiCost({ ...t, requests: 3 }, O, prices, "claude-code", 2100)).toBeCloseTo((400 * p.output) / 1e6, 12);
    expect(directApiCost(t, O, prices, "api", 2100)).toBeCloseTo(priceTokens(t, O, prices, "api"), 12);
  });

  it("all-Fable is the same tokens at Fable rates, on both bases", () => {
    const v = costViews([{ ...t, model: S, cost_usd: priceTokens(t, S, prices, "claude-code") }], F, prices, "claude-code", 2100);
    expect(v.baseline_usd).toBeCloseTo(priceTokens(t, F, prices, "claude-code"), 12);
    expect(v.baseline_direct_api_usd).toBeCloseTo(directApiCost(t, F, prices, "claude-code", 2100), 12);
    expect(v.direct_api_usd).toBeLessThan(v.actual_usd);
  });
});

describe("Tier 2 / Tier 3 merge", () => {
  const off = applyFablePolicy(cfg, "claude-code", false).cfg;
  const routed = routeDiff([hunk("src/a.ts", ["+x"]), hunk("src/auth/login.py", ["+jwt.sign(x)"]), hunk("src/auth/sql.py", ["+jwt.sign(x)", "+f'select {x}'"])], off);

  it("merges only when both tiers run the same model, at the higher effort", () => {
    expect(tiersMerged(cfg)).toBe(false);
    expect(tiersMerged(off)).toBe(true);
    const c = collapseTiers(off, routed);
    expect(c.cfg.models.tier3).toEqual({ model: O, effort: "high" });
    expect(c.routed.some((h) => h.tier === 2)).toBe(false);
    expect(c.routed.filter((h) => h.tier === 3).length).toBe(routed.filter((h) => h.tier >= 2).length);
    expect(collapseTiers(cfg, routed).routed).toBe(routed);
  });

  it("plans one Opus tier in the dry-run estimate and degrades Tier 3 straight to Tier 1", () => {
    const plan = estimatePlan(routed, off, prices, est, "claude-code");
    expect(plan.tiers[1]!.hunks).toBe(0);
    expect(plan.tiers[2]!.requests).toBe(1);
    expect(plan.baseline.method).toBe("estimated_tokens_at_baseline_prices");
    const c = collapseTiers(off, routed);
    const d = degradePlan(c.routed, c.cfg, prices, est, 0.0001, "claude-code");
    expect(d.moves.some((m) => m.includes("tier 3 -> 1"))).toBe(true);
    expect(d.moves.some((m) => m.includes("tier 3 -> 2"))).toBe(false);
  });
});
