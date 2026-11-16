// P3-05 escalate, P3-06 budget, P3-07 merge.
import { describe, expect, it } from "vitest";
import { Ledger, degradePlan, worstCase } from "../src/budget";
import { estimatePlan, loadEstimates } from "../src/estimate";
import { findingId, isDuplicate, jaccard, mergeFindings, toFinding } from "../src/merge";
import { loadPrices } from "../src/prices";
import { contradictions, decideEscalation, ruleFor, sanitizeReview } from "../src/tiers/escalate";
import type { HunkReview, ScoredHunk } from "../src/types";
import { clean, finding } from "./fake-client";
import { cfg, hunk } from "./helpers";

const h = { ...hunk("src/a.ts", [" a", " b", "+c", "+d", " e"]), newStart: 10, newLines: 5, oldStart: 10, oldLines: 3 };
const t1 = ruleFor(1, cfg);
const t2 = ruleFor(2, cfg);
const rev = (over: Partial<HunkReview>): HunkReview => ({ ...clean(h.id), ...over });

describe("escalate", () => {
  it("does not escalate a confident clean review", () => {
    expect(decideEscalation(rev({}), h, t1).escalate).toBe(false);
  });
  it("E1 low confidence (0.7 from tier 1, 0.6 from tier 2)", () => {
    expect(decideEscalation(rev({ confidence: 0.65 }), h, t1).reasons[0]).toMatch(/^E1/);
    expect(decideEscalation(rev({ confidence: 0.65 }), h, t2).escalate).toBe(false);
  });
  it("E2 the model asks to escalate", () => {
    expect(decideEscalation(rev({ needs_escalation: true, escalation_reason: "needs caller" }), h, t1).reasons[0]).toMatch(/^E2.*needs caller/);
  });
  it("E3 high findings from tier 1, only critical from tier 2", () => {
    const high = rev({ verdict: "issues", findings: [finding("src/a.ts", 12, { severity: "high" })] });
    expect(decideEscalation(high, h, t1).reasons.some((r) => r.startsWith("E3"))).toBe(true);
    expect(decideEscalation(high, h, t2).escalate).toBe(false);
    const crit = rev({ verdict: "issues", findings: [finding("src/a.ts", 12, { severity: "critical" })] });
    expect(decideEscalation(crit, h, t2).reasons[0]).toMatch(/^E3/);
  });
  it("E4a verdict and findings disagree", () => {
    expect(contradictions(rev({ verdict: "clean", findings: [finding("src/a.ts", 12)] }), h)[0]).toMatch(/^E4a/);
    expect(contradictions(rev({ verdict: "issues" }), h)[0]).toMatch(/^E4a/);
  });
  it("E4b a finding outside the hunk's file or lines", () => {
    expect(contradictions(rev({ verdict: "issues", findings: [finding("src/b.ts", 12)] }), h)[0]).toMatch(/^E4b.*src\/b\.ts/);
    expect(contradictions(rev({ verdict: "issues", findings: [finding("src/a.ts", 40)] }), h)[0]).toMatch(/^E4b.*40-40/);
    expect(contradictions(rev({ verdict: "issues", findings: [finding("src/a.ts", 16)] }), h)).toEqual([]); // within slack
  });
  it("E4c overlapping findings two severity levels apart", () => {
    const r = rev({ verdict: "issues", findings: [finding("src/a.ts", 12, { severity: "critical" }), finding("src/a.ts", 12, { severity: "medium", title: "x" })] });
    expect(contradictions(r, h).some((c) => c.startsWith("E4c"))).toBe(true);
  });
  it("E5 failure or missing hunk", () => {
    expect(decideEscalation(null, h, t1, "refusal: cyber").reasons[0]).toBe("E5 refusal: cyber");
    expect(decideEscalation(null, h, t2).reasons[0]).toMatch(/^E5 missing/);
  });
  it("clamps confidence and long titles client-side", () => {
    const s = sanitizeReview(rev({ confidence: 1.7, findings: [finding("src/a.ts", 13, { confidence: -1, title: "x".repeat(120), start_line: 14, end_line: 12 })] }));
    expect(s.confidence).toBe(1);
    expect(s.findings[0]!.confidence).toBe(0);
    expect(s.findings[0]!.title.length).toBe(80);
    expect([s.findings[0]!.start_line, s.findings[0]!.end_line]).toEqual([12, 14]);
  });
});

describe("merge", () => {
  const f = (tier: 1 | 2 | 3, over = {}) => toFinding(finding("src/a.ts", 12, over), h.id, `model-${tier}`, tier, []);

  it("ids are stable and ignore title punctuation and case", () => {
    expect(findingId(finding("a", 1, { title: "Off-by-one!" }))).toBe(findingId(finding("a", 1, { title: "off by one" })));
    expect(findingId(finding("a", 1))).toHaveLength(12);
  });

  it("dedupes within ±3 lines and Jaccard ≥ 0.5, keeping the highest tier", () => {
    expect(jaccard("a b c d", "a b c e")).toBeCloseTo(0.6);
    const a = f(1);
    const b = toFinding(finding("src/a.ts", 14), h.id, "model-3", 3, [1, 2]);
    expect(isDuplicate(a, b)).toBe(true);
    expect(isDuplicate(a, f(1, { category: "security" }))).toBe(false);
    expect(isDuplicate(a, toFinding(finding("src/a.ts", 20), h.id, "m", 1, []))).toBe(false);
    const m = mergeFindings([a, b], new Map());
    expect(m.findings).toHaveLength(1);
    expect(m.findings[0]!.tier).toBe(3);
    expect(m.findings[0]!.also_reported_by).toEqual(["model-1 (tier 1)"]);
  });

  it("removes findings a higher tier refuted, but not when the refuting tier is not higher", () => {
    const a = f(1);
    expect(mergeFindings([a], new Map([[a.id, 2]])).refuted).toHaveLength(1);
    const c = f(2);
    expect(mergeFindings([c], new Map([[c.id, 2]])).findings).toHaveLength(1);
  });

  it("ranks by severity, then confidence, then tier", () => {
    const low = toFinding(finding("x", 1, { severity: "low", title: "a" }), "x#1", "m", 3, []);
    const hiA = toFinding(finding("y", 1, { severity: "high", confidence: 0.6, title: "b" }), "y#1", "m", 3, []);
    const hiB = toFinding(finding("z", 1, { severity: "high", confidence: 0.9, title: "c" }), "z#1", "m", 1, []);
    expect(mergeFindings([low, hiA, hiB], new Map()).findings.map((x) => x.file)).toEqual(["z", "y", "x"]);
  });
});

describe("budget", () => {
  const prices = loadPrices();
  const est = loadEstimates();
  const sh = (file: string, tier: 1 | 2 | 3, score: number): ScoredHunk => ({ ...hunk(file, Array.from({ length: 20 }, (_, i) => `+line ${i}`)), fileKind: "source", tier, score, reasons: [] });
  const routed = [sh("a.ts", 3, 80), sh("b.ts", 3, 65), sh("c.ts", 2, 40), sh("d.ts", 1, 10), sh("e.ts", 1, 5)];

  it("reserves worst cases and refuses past the cap", () => {
    const l = new Ledger(1);
    const a = l.reserve(0.6)!;
    expect(l.reserve(0.5)).toBeNull();
    l.settle(a, 0.1);
    expect(l.reserve(0.5)).not.toBeNull();
    expect(new Ledger(null).reserve(1e9)).not.toBeNull();
    expect(worstCase(1000, 16000, prices.models["claude-sonnet-5-5"]!)).toBeCloseTo((1000 * 2 + 16000 * 10) / 1e6);
  });

  it("does nothing when the plan fits", () => {
    expect(degradePlan(routed, cfg, prices, est, 100, "api").degraded).toBe(false);
  });

  it("degrades Tier 3 first, lowest score first, then drops Tier 1", () => {
    const full = estimatePlan(routed, cfg, prices, est);
    const d = degradePlan(routed, cfg, prices, est, (full.total_usd + full.reserve_usd) * 0.8, "api");
    expect(d.degraded).toBe(true);
    expect(d.moves[0]).toBe("b.ts#1: tier 3 -> 2");
    const tiny = degradePlan(routed, cfg, prices, est, 0.0001, "api");
    expect(tiny.dropped.length).toBe(5);
    expect(tiny.moves.at(-1)).toMatch(/dropped/);
  });

  it("never exceeds the cap in a simulated run", () => {
    const cap = 0.05;
    const l = new Ledger(cap);
    for (let i = 0; i < 50; i++) {
      const t = l.reserve(0.004);
      if (t !== null) l.settle(t, 0.004 * Math.random());
    }
    expect(l.spent).toBeLessThanOrEqual(cap);
  });
});
