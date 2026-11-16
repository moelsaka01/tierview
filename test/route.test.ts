import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff, tierForScore } from "../src/tier0/route";
import { cfg, hunk } from "./helpers";

const fx = (n: string) => parseDiff(readFileSync(`test/fixtures/${n}`, "utf8"));
const one = (n: string) => routeDiff(fx(n), cfg)[0]!;

describe("worked examples from PLAN §4", () => {
  it("src/auth/login.py with f-string SQL: auth 35 + sql 30 + size 5 = 70 -> Tier 3", () => {
    const hs = routeDiff(fx("auth-login-sql.diff"), cfg);
    expect(hs).toHaveLength(1);
    const h = hs[0]!;
    expect(h.added + h.deleted).toBe(6);
    expect(h.reasons.map((r) => [r.signal, r.weight])).toEqual([
      ["auth", 35],
      ["sql", 30],
      ["size", 5],
    ]);
    expect(h).toMatchObject({ score: 70, tier: 3 });
  });

  it("src/auth/session.ts, 8 lines, nothing else: 35 + 5 = 40 -> Tier 2", () => {
    const h = one("auth-session.diff");
    expect(h.added + h.deleted).toBe(8);
    expect(h.reasons.map((r) => r.signal)).toEqual(["auth", "size"]);
    expect(h).toMatchObject({ score: 40, tier: 2 });
  });

  it("src/utils/format.ts, 20 lines: 5 -> Tier 1", () => {
    const h = one("format.diff");
    expect(h.added + h.deleted).toBe(20);
    expect(h).toMatchObject({ score: 5, tier: 1 });
  });

  it("README.md scores at most 5 -> Tier 1", () => {
    expect(one("readme.diff")).toMatchObject({ fileKind: "docs", score: 0, tier: 1 });
  });

  it("package-lock.json is generated -> skipped (tier 0)", () => {
    expect(one("lockfile.diff")).toMatchObject({ fileKind: "generated", score: 0, tier: 0 });
  });
});

describe("score mechanics", () => {
  it("takes the max per category, then caps at 100", () => {
    const body = ["+const a = jwt.sign(x);", "+pickle.loads(x); eval(y); shell=True; md5; db.execute(f'select {x}')", "+stripe.charge(); is_admin = 1; mutex.lock()"];
    const h = routeDiff([hunk("src/auth/payment/crypto/x.ts", body)], cfg)[0]!;
    expect(h.score).toBe(100);
    expect(h.tier).toBe(3);
  });

  it("reduces test files without a test signal", () => {
    const h = routeDiff([hunk("test/auth.test.ts", ["+const t = jwt.sign(x);"])], cfg)[0]!;
    expect(h.reasons.find((r) => r.signal === "test_file")?.weight).toBe(-15);
    expect(h.score).toBe(20);
  });

  it("caps comment-only hunks", () => {
    const h = routeDiff([hunk("src/auth/login.ts", ["-// old note", "+// new note"])], cfg)[0]!;
    expect(h.score).toBe(5);
  });

  it("records churn reasons when history is given", () => {
    const h = routeDiff([hunk("src/a.ts", ["+x"])], cfg, { "src/a.ts": { commits: 12, fixCommits: 3 } })[0]!;
    expect(h.score).toBe(20);
  });
});

describe("routing", () => {
  it("applies thresholds at their boundaries", () => {
    expect([24, 25, 59, 60].map((s) => tierForScore(s, cfg))).toEqual([1, 2, 2, 3]); // tier2 threshold 25 since P4-09
  });

  const withYml = (rules: object) => ({ ...cfg, ...rules });

  it("ignore globs send hunks to tier 0", () => {
    const c = withYml({ ignore: ["src/legacy/**"] });
    const h = routeDiff([hunk("src/legacy/auth.ts", ["+jwt.sign(x)"])], c)[0]!;
    expect(h.tier).toBe(0);
    expect(h.reasons.at(-1)?.signal).toBe("ignore");
  });

  it("rules apply min_tier, max_tier and add in order", () => {
    const c = withYml({
      rules: [
        { paths: ["src/billing/**"], min_tier: 3 },
        { paths: ["scripts/**"], max_tier: 1 },
        { paths: ["src/x/**"], add: 30 },
      ],
    });
    const [a, b, d, e] = routeDiff(
      [
        hunk("src/billing/util.ts", ["+x"]),
        hunk("scripts/auth.ts", ["+jwt.sign(x)"]),
        hunk("src/x/a.ts", ["+x"]),
        hunk("src/y/a.ts", ["+x"]),
      ],
      c,
    );
    expect([a, b, d, e].map((h) => h!.tier)).toEqual([3, 1, 2, 1]);
    expect(d!.score).toBe(30);
  });

  it("generated files stay at tier 0 even with a min_tier rule", () => {
    const c = withYml({ rules: [{ paths: ["**"], min_tier: 3 }] });
    expect(routeDiff([hunk("package-lock.json", ["+x"])], c)[0]!.tier).toBe(0);
  });

  it("loads thresholds from .tierview.yml", () => {
    expect(loadConfig({ cwd: "test/fixtures" }).thresholds.tier2).toBe(25);
  });
});
