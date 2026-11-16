// P3-08 receipt and output, P3-09 pipeline with the fake backend.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/cli";
import { FABLE_WARNING, displayName } from "../src/fable";
import { loadEstimates } from "../src/estimate";
import { renderReview } from "../src/output/terminal";
import { runPipeline } from "../src/pipeline";
import { loadPrices } from "../src/prices";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import { Review } from "../src/types";
import { FakeBackend, finding } from "./fake-client";
import { cfg } from "./helpers";

const prices = loadPrices();
const est = loadEstimates();
const mixed = readFileSync("test/fixtures/mixed.diff", "utf8");
const routed = routeDiff(parseDiff(mixed), cfg, null);
const LOGIN = "src/auth/login.py#1";
const FORMAT = "src/utils/format.ts#1";
const TESTS = "tests/a.test.ts#1";
const README = "README.md#1";
const run = (backend: FakeBackend, maxCost: number | null = null) => runPipeline({ routed, cfg, backend, files: () => null, prices, est, maxCost, now: () => 0 });

describe("pipeline", () => {
  it("runs every Tier 1 batch first, then Tier 2, then Tier 3, and produces a valid Review", async () => {
    const b = new FakeBackend(() => ({}));
    const { review, budgetExhausted } = await run(b);
    expect(Review.safeParse(review).success).toBe(true);
    expect(b.requests.map((r) => r.tier)).toEqual([1, 2, 3]);
    expect(b.requests[0]!.hunkIds.sort()).toEqual([README, FORMAT].sort());
    expect(review.findings).toEqual([]);
    expect(review.receipt.skipped_hunks).toBe(1);
    expect(review.receipt.calls).toBe(3);
    expect(review.receipt.cost_basis).toBe("billed");
    expect(budgetExhausted).toBe(false);
    // 3 requests x (1000 input + 200 output) at each tier's price
    const expected = [2, 4, 8].reduce((a, p, i) => a + (1000 * p + 200 * [10, 20, 40][i]!) / 1e6, 0);
    expect(review.receipt.total_cost_usd).toBeCloseTo(expected, 10);
    expect(review.receipt.baseline.model).toBe(cfg.receipt.baseline.model);
  });

  it("follows an escalation chain 1 -> 2 -> 3 with prior findings, and merges refutations", async () => {
    const t1Finding = finding("src/utils/format.ts", 3, { severity: "high", title: "Format drops the sign of negative numbers" });
    const b = new FakeBackend((req) => {
      if (req.tier === 1) return { [FORMAT]: { verdict: "issues", findings: [t1Finding], confidence: 0.9 } };
      if (req.tier === 2 && req.hunkIds.includes(FORMAT)) return { [FORMAT]: { verdict: "unsure", confidence: 0.4, needs_escalation: true, escalation_reason: "needs caller" } };
      if (req.tier === 3 && req.hunkIds.includes(FORMAT)) {
        const prior = req.user.match(/"id":"([0-9a-f]{12})"/)![1]!;
        return { [FORMAT]: { verdict: "clean", refuted_prior: [prior] } };
      }
      return {};
    });
    const { review } = await run(b);
    // Whole-diff escalation: each higher tier runs once, its own hunks and the escalated ones together
    // (on the api backend Tiers 2 and 3 still send one request per file: TESTS and FORMAT, LOGIN and FORMAT).
    expect(b.requests.map((r) => r.tier)).toEqual([1, 2, 2, 3, 3]);
    expect(b.requests.find((r) => r.tier === 2 && r.hunkIds.includes(FORMAT))!.user).toContain("<prior_findings>");
    expect(review.findings).toEqual([]);
    expect(review.refuted).toHaveLength(1);
    expect(review.refuted[0]!.tier).toBe(1);
    const tiers = review.receipt.tiers;
    expect(tiers[1]!.escalated_in).toBe(1);
    expect(tiers[2]!.escalated_in).toBe(1);
    expect(review.receipt.warnings.some((w) => w.startsWith("calibration"))).toBe(true);
  });

  it("keeps a confirmed finding from the higher tier, labelled with its escalation path", async () => {
    const f = finding("src/utils/format.ts", 3, { severity: "high", title: "Format drops the sign of negative numbers" });
    const b = new FakeBackend((req) => (req.hunkIds.includes(FORMAT) && req.tier <= 2 ? { [FORMAT]: { verdict: "issues", findings: [f] } } : {}));
    const { review } = await run(b);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ tier: 2, escalated_from: [1], also_reported_by: [`${cfg.models.tier1.model} (tier 1)`] });
  });

  it("escalates refusals and missing hunks (E5), and marks Tier 3 failures not_reviewed", async () => {
    const b = new FakeBackend((req) => {
      if (req.tier === 3) return { fail: "refusal" };
      if (req.tier === 1) return { [README]: "omit" };
      return {};
    });
    const { review } = await run(b);
    expect(b.requests.filter((r) => r.tier === 2).flatMap((r) => r.hunkIds)).toContain(README);
    expect(review.not_reviewed.map((x) => x.hunk_id)).toEqual([LOGIN]);
    expect(review.not_reviewed[0]!.reason).toMatch(/^tier 3 refusal/);
  });

  it("stops at the budget: degrades, drops, and reports exhaustion", async () => {
    const b = new FakeBackend(() => ({}));
    const { review, budgetExhausted } = await run(b, 0.0005);
    expect(budgetExhausted).toBe(true);
    expect(review.receipt.budget).toEqual({ max_cost_usd: 0.0005, degraded: true });
    expect(review.receipt.total_cost_usd).toBeLessThanOrEqual(0.0005);
    expect(review.not_reviewed.every((x) => x.reason === "budget")).toBe(true);
    expect(review.not_reviewed.length).toBeGreaterThan(0);
  });

  it("stops at --max-calls and marks the rest not reviewed", async () => {
    const b = new FakeBackend(() => ({}));
    const { review, budgetExhausted } = await runPipeline({ routed, cfg, backend: b, files: () => null, prices, est, maxCost: null, maxCalls: 2, now: () => 0 });
    expect(b.requests).toHaveLength(2);
    expect(budgetExhausted).toBe(true);
    expect(review.not_reviewed.map((x) => x.hunk_id).sort()).toEqual([README, FORMAT].sort());
  });

  it("keeps the lower-tier review when --max-calls blocks an escalation", async () => {
    const f = finding("src/utils/format.ts", 3, { severity: "high" });
    const b = new FakeBackend((req) => (req.tier === 1 ? { [FORMAT]: { verdict: "issues", findings: [f] } } : {}));
    const { review, budgetExhausted } = await runPipeline({ routed, cfg, backend: b, files: () => null, prices, est, maxCost: null, maxCalls: 3, now: () => 0 });
    expect(budgetExhausted).toBe(true);
    expect(review.not_reviewed).toEqual([]);
    expect(review.findings).toHaveLength(1);
    expect(review.receipt.warnings.some((w) => w.startsWith("escalation not sent") && w.includes(FORMAT))).toBe(true);
  });

  it("caches the shared prefix only when a tier sends two or more API requests", async () => {
    const b = new FakeBackend(() => ({}));
    await run(b);
    expect(b.requests.every((r) => r.cache === false)).toBe(true);
  });

  it("asks claude-code for the Tier 2 model as Tier 3's fallback and labels costs API-equivalent", async () => {
    const b = new FakeBackend(() => ({}), "claude-code", 1);
    b.subs = [{ tier: 3, requested: cfg.models.tier3.model, used: cfg.models.tier2.model, reason: "not on plan" }];
    const { review } = await run(b);
    expect(b.requests.find((r) => r.tier === 3)!.fallbackModel).toBe(cfg.models.tier2.model);
    expect(b.requests.find((r) => r.tier === 2)!.fallbackModel).toBeUndefined();
    expect(review.receipt.cost_basis).toBe("api_equivalent");
    expect(review.receipt.model_substitutions).toHaveLength(1);
    const text = renderReview(review);
    expect(text).toContain("API-equivalent");
    expect(text).toContain(`Tier 3 ran on ${displayName(cfg.models.tier2.model)} instead of ${displayName(cfg.models.tier3.model)} (not on plan)`);
    expect(text).toContain(`all-${cfg.receipt.baseline.model}`);
  });
});

describe("review command", () => {
  const io = (backend: FakeBackend) => {
    const s = { out: "", err: "" };
    return { s, io: { out: (x: string) => (s.out += x), err: (x: string) => (s.err += x), diff: mixed, cwd: "test/fixtures", backend } };
  };

  it("prints JSON and exits 1 on --fail-on", async () => {
    const f = finding("src/auth/login.py", 1, { severity: "critical", category: "security", title: "SQL injection via f-string" });
    const b = new FakeBackend((req) => (req.tier === 3 ? { [LOGIN]: { verdict: "issues", findings: [f] } } : {}));
    const { s, io: i } = io(b);
    expect(await runReview({ json: true, failOn: "high" }, i)).toBe(1);
    const j = Review.parse(JSON.parse(s.out));
    expect(j.findings[0]!.title).toBe("SQL injection via f-string");
  });

  it("exits 0 when findings stay below --fail-on, 3 on a budget stop, 2 on a bad --fail-on", async () => {
    expect(await runReview({ failOn: "critical" }, io(new FakeBackend(() => ({}))).io)).toBe(0);
    expect(await runReview({ maxCost: 0.0005 }, io(new FakeBackend(() => ({}))).io)).toBe(3);
    expect(await runReview({ failOn: "urgent" }, io(new FakeBackend(() => ({}))).io)).toBe(2);
  });

  it("claude-code without opt-in: Tier 3 goes straight to Opus, never Fable, and the receipt says so", async () => {
    const b = new FakeBackend(() => ({}), "claude-code", 1);
    const { s, io: i } = io(b);
    expect(await runReview({}, i)).toBe(0);
    expect(b.requests.some((r) => /fable/i.test(r.model) || /fable/i.test(r.fallbackModel ?? ""))).toBe(false);
    expect(b.requests.find((r) => r.tier === 3)!.model).toBe(cfg.models.tier2.model);
    expect(b.requests.find((r) => r.tier === 3)!.effort).toBe(cfg.models.tier3.effort);
    expect(s.out).toContain("Tier 3 ran on Opus 5.5 (Fable not enabled)");
    expect(s.out).toContain(`all-${cfg.receipt.baseline.model}`); // the all-Fable comparison stays (a calculation)
    expect(s.err).not.toContain("paid extra usage");
  });

  it("claude-code with --allow-fable: requests Fable and warns before the first call", async () => {
    const { s, io: i } = io(new FakeBackend(() => ({})));
    let errAtFirstCall: string | null = null;
    const b = new FakeBackend(() => {
      errAtFirstCall ??= s.err;
      return {};
    }, "claude-code", 1);
    i.backend = b;
    await runReview({ allowFable: true }, i);
    expect(b.requests.find((r) => r.tier === 3)!.model).toBe(cfg.models.tier3.model);
    expect(errAtFirstCall).toContain(FABLE_WARNING.trim());
    expect(s.out).not.toContain("Fable not enabled");
  });

  it("allowFable: true in .tierview.yml enables Fable; the api backend is unaffected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tierview-cfg-"));
    const file = join(dir, ".tierview.yml");
    writeFileSync(file, "allowFable: true\n");
    const b = new FakeBackend(() => ({}), "claude-code", 1);
    const { s, io: i } = io(b);
    await runReview({ config: file }, i);
    expect(b.requests.find((r) => r.tier === 3)!.model).toBe(cfg.models.tier3.model);
    expect(s.err).toContain("paid extra usage");
    const api = new FakeBackend(() => ({}));
    await runReview({ backend: "api" }, io(api).io);
    expect(api.requests.find((r) => r.tier === 3)!.model).toBe(cfg.models.tier3.model);
  });

  it("dry-run on claude-code says Tier 3 will run on Opus without opt-in", async () => {
    const { s, io: i } = io(new FakeBackend(() => ({}), "claude-code"));
    await runReview({ dryRun: true }, i);
    expect(s.out).toContain("Tier 3 will run on Opus 5.5 (Fable not enabled");
    const on = io(new FakeBackend(() => ({}), "claude-code"));
    await runReview({ dryRun: true, allowFable: true }, on.io);
    expect(on.s.out).not.toContain("Fable not enabled");
    expect(on.s.err).toBe(""); // no calls in a dry run, so no warning
  });

  it("prints a receipt with tokens per tier", async () => {
    const { s, io: i } = io(new FakeBackend(() => ({})));
    await runReview({}, i);
    expect(s.out).toMatch(/Receipt \(api backend: 3 request/);
    expect(s.out).toContain("cache write");
  });
});

void TESTS;

describe("baseline", () => {
  it("stays on the configured baseline model when Tier 3 is overridden", async () => {
    const opusT3 = { ...cfg, models: { ...cfg.models, tier3: { model: cfg.models.tier2.model, effort: "high" as const } } };
    const { review } = await runPipeline({ routed, cfg: opusT3, backend: new FakeBackend(() => ({})), files: () => null, prices, est, maxCost: null, now: () => 0 });
    expect(review.receipt.baseline.model).toBe(cfg.receipt.baseline.model);
    expect(review.receipt.tiers[2]!.model).toBe(cfg.models.tier2.model);
  });
});
