// Judge v2: for wide fixes a location match needs a mechanism term; re-judging saved runs; the judge is frozen in
// the config hash. No model calls.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_VERSION, type Judgement, RULE, classify, judgeConfig, mechanismTerms, ruleJudge, stems } from "../bench/judge";
import { judgementsFor } from "../bench/metrics";
import { faultyHunks, loadCases } from "../bench/routing";
import { type RunFile, configHash, rejudge } from "../bench/run";
import { parseDiff } from "../src/tier0/diff";
import type { Finding } from "../src/types";
import { finding } from "./fake-client";

const cases = loadCases();
const TS = cases.find((x) => x.c.id === "tailscale-halfclose-shutdown")!;
const NTB = cases.find((x) => x.c.id === "dpdk-ntb-window-bound")!;
const TS_FILE = TS.c.faulty[0]!.file;
const TS_LINE = TS.c.faulty[0]!.lines[0]!;

const asFinding = (over: Partial<Finding>): Finding =>
  ({ ...finding(TS_FILE, TS_LINE), id: "x", hunk_id: "h", model: "m", tier: 3, escalated_from: [], also_reported_by: [], ...over }) as Finding;

describe("mechanism terms", () => {
  it("come from the bug and fix text, minus stopwords and anything in the reviewed diff", () => {
    const t = mechanismTerms(TS.c, TS.diff);
    expect(t).toContain("enotconn");
    expect(t).not.toContain("backend"); // a name of the code under review
    expect(t).not.toContain("the");
    expect(t.every((w) => w.length >= RULE.minTermLength)).toBe(true);
    expect(mechanismTerms({ fix: null }, "")).toEqual([]);
    expect(stems("Shutdown fails, shutting")).toEqual(new Set(["shutdown", "fail", "shutt"]));
  });
});

describe("wide-fix rule", () => {
  const hunks = parseDiff(TS.diff);
  const terms = mechanismTerms(TS.c, TS.diff);
  const span = Math.max(...TS.c.faulty[0]!.lines) - Math.min(...TS.c.faulty[0]!.lines) + 1;

  it("Tailscale is wide; NTB is not", () => {
    expect(span).toBeGreaterThan(RULE.wideSpan);
    expect(Math.max(...NTB.c.faulty[0]!.lines) - Math.min(...NTB.c.faulty[0]!.lines) + 1).toBeLessThanOrEqual(RULE.wideSpan);
  });

  it("a location match without a mechanism term is ambiguous; with one it matches", () => {
    const near = { file: TS_FILE, start_line: TS_LINE, end_line: TS_LINE, side: "new" as const };
    const generic = classify({ ...near, title: "Backend EOF is not propagated", explanation: "The forwarder keeps the backend socket open." }, TS.c, hunks, terms);
    expect(generic.cls).toBe("ambiguous");
    expect(generic.reason).toMatch(/wide fix/);
    const specific = classify({ ...near, title: "shutdown(SHUT_RD) fails with ENOTCONN", explanation: "" }, TS.c, hunks, terms);
    expect(specific).toMatchObject({ cls: "match" });
    expect(specific.reason).toMatch(/mechanism terms: .*enotconn/);
  });

  it("narrow fixes keep the plain location rule, and every arm gets the same rule", () => {
    const ntbLine = NTB.c.faulty[0]!.lines[0]!;
    const f = { ...asFinding({ file: NTB.c.faulty[0]!.file, start_line: ntbLine, end_line: ntbLine }), title: "anything" };
    for (const arm of ["tierview", "all-sonnet", "all-opus"]) {
      expect(ruleJudge(NTB.c, arm, [f], NTB.diff).judged[0]).toMatchObject({ verdict: "match", judge_version: JUDGE_VERSION });
      expect(ruleJudge(TS.c, arm, [asFinding({ title: "EOF handling", explanation: "" })], TS.diff).ambiguous).toHaveLength(1);
    }
    expect(faultyHunks(hunks, TS.c.faulty).length).toBeGreaterThan(0);
  });
});

describe("frozen judge", () => {
  it("is part of the config hash", () => {
    expect(judgeConfig()).toContain(`"version":${JUDGE_VERSION}`);
    expect(configHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("re-judging saved runs", () => {
  it("re-judges from saved findings, reuses earlier model verdicts, counts the rest as pending, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-rejudge-"));
    mkdirSync(join(dir, "runs"));
    const generic = asFinding({ id: "g", title: "Backend EOF is not propagated", explanation: "" });
    const other = asFinding({ id: "o", title: "Read side kept open", explanation: "" });
    const run = { case_id: TS.c.id, arm: "all-opus", arm_version: 1, batch: "b1", config_hash: "x", complete: true, calls: 1, wall_ms: 1, judge_pending: [], review: { findings: [generic, other], refuted: [] } } as unknown as RunFile;
    writeFileSync(join(dir, "runs", `${TS.c.id}__all-opus.json`), JSON.stringify(run));
    // v1: both matched by rule; one also had a model verdict (as if it had been ambiguous then).
    const v1 = (id: string, method: "rule" | "model", verdict: "match" | "no_match") => ({ case_id: TS.c.id, arm: "all-opus", finding_id: id, method, verdict, reason: "v1", batch: "b1", run_batch: "b1" });
    appendFileSync(join(dir, "judgements.jsonl"), [v1("g", "rule", "match"), v1("o", "rule", "match"), v1("g", "model", "no_match")].map((j) => JSON.stringify(j)).join("\n") + "\n");

    const r = rejudge(dir, TS.c.id, "t1");
    expect(r).toMatchObject({ runs: 1, findings: 2, ambiguous: 2, reusedModel: 1, pending: 1, opusCallsNeeded: 1 });
    const saved = JSON.parse(readFileSync(join(dir, "runs", `${TS.c.id}__all-opus.json`), "utf8")) as RunFile;
    expect(saved.judge_pending).toEqual(["o"]);
    const all = readFileSync(join(dir, "judgements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Judgement);
    // Metrics count only v2 judgements: the reused model "no_match" for g; o is still pending (no judgement).
    expect(judgementsFor(all, saved).map((j) => [j.finding_id, j.method, j.verdict])).toEqual([["g", "model", "no_match"]]);
    expect(rejudge(dir, TS.c.id, "t2").runs).toBe(0);
  });
});
