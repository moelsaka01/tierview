import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runReview } from "../src/cli";

function run(opts: Parameters<typeof runReview>[0], diff?: string) {
  let out = "";
  let err = "";
  const code = runReview(opts, { out: (s) => (out += s), err: (s) => (err += s), diff, cwd: "test/fixtures" });
  return { code, out, err };
}
const mixed = readFileSync("test/fixtures/mixed.diff", "utf8");

describe("review --dry-run", () => {
  it("matches the snapshot on a mixed diff", async () => {
    const r = run({ dryRun: true }, mixed);
    expect(r.code).toBe(0);
    await expect(r.out).toMatchFileSnapshot("snapshots/dry-run.txt");
  });

  it("matches the snapshot with --max-cost below the plan", async () => {
    const r = run({ dryRun: true, maxCost: 0.001 }, mixed);
    await expect(r.out).toMatchFileSnapshot("snapshots/dry-run-max-cost.txt");
  });

  it("emits valid JSON with --json", () => {
    const r = run({ dryRun: true, json: true }, mixed);
    const j = JSON.parse(r.out);
    expect(j.dry_run).toBe(true);
    expect(j.routing.length).toBeGreaterThan(0);
    expect(j.estimate.baseline.method).toBe("estimated");
    expect(j.estimate.prices_as_of).toMatch(/^\d{4}/);
  });

  it("routes the SQL-in-auth hunk to tier 3 and skips the lockfile", () => {
    const j = JSON.parse(run({ dryRun: true, json: true }, mixed).out);
    const byId = Object.fromEntries(j.routing.map((r: { hunk_id: string }) => [r.hunk_id, r]));
    expect(byId["src/auth/login.py#1"].tier).toBe(3);
    expect(byId["package-lock.json#1"].tier).toBe(0);
  });

  it("says so when there is nothing to review", () => {
    const r = run({ dryRun: true }, "");
    expect(r).toMatchObject({ code: 0, out: "No changes to review.\n" });
  });

  it("exits 2 without --dry-run until Phase 3", () => {
    const r = run({}, mixed);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Phase 3");
  });

  it("exits 2 on a bad --max-cost", () => {
    expect(run({ dryRun: true, maxCost: -1 }, mixed).code).toBe(2);
  });
});
