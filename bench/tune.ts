// P4-09: routing report for weight and threshold tuning. Dev split only, no model calls. Spec: PLAN.md §9.
//   node .bench-build/tune.js [--split dev] [--verbose]
// Reports routing recall (faulty hunks at Tier 2+) and the share of reviewable hunks sent to Opus (the cost driver),
// for buggy and clean cases separately.
import { type Config, loadConfig } from "../src/config";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import { armPreset } from "./arms";
import { faultyHunks, loadCases } from "./routing";
import { BENCH } from "./lib/sh";

export interface TuneReport {
  buggy: number;
  faultyHigh: number;
  /** Reviewable hunks routed to Tier 2+ / all reviewable hunks, over every case of the split. */
  opusShare: number;
  /** Same, clean cases only. */
  opusShareClean: number;
  rows: { id: string; kind: string; hunks: number; high: number; faulty?: { score: number; tier: number; reasons: string }[] }[];
}

export function tuneReport(cfg: Config, split: string): TuneReport {
  const tv = armPreset("tierview", cfg).cfg;
  const cases = loadCases().filter((x) => split === "all" || x.c.split === split);
  const rows: TuneReport["rows"] = [];
  let rev = 0, hi = 0, revC = 0, hiC = 0, faultyHigh = 0, buggy = 0;
  for (const { c, diff } of cases) {
    const routed = routeDiff(parseDiff(diff), tv, null).filter((h) => h.tier !== 0);
    const high = routed.filter((h) => h.tier >= 2).length;
    rev += routed.length;
    hi += high;
    if (c.kind === "clean") {
      revC += routed.length;
      hiC += high;
      rows.push({ id: c.id, kind: c.kind, hunks: routed.length, high });
      continue;
    }
    buggy++;
    const fh = faultyHunks(routed, c.faulty);
    if (fh.some((h) => h.tier >= 2)) faultyHigh++;
    rows.push({
      id: c.id,
      kind: c.kind,
      hunks: routed.length,
      high,
      faulty: fh.map((h) => ({ score: h.score, tier: h.tier, reasons: h.reasons.filter((r) => r.weight).map((r) => `${r.signal} ${r.weight}`).join(", ") || "none" })),
    });
  }
  return { buggy, faultyHigh, opusShare: rev ? hi / rev : 0, opusShareClean: revC ? hiC / revC : 0, rows };
}

function main(): void {
  const i = process.argv.indexOf("--split");
  const split = i >= 0 ? process.argv[i + 1]! : "dev";
  const r = tuneReport(loadConfig({ cwd: BENCH }), split);
  for (const row of r.rows) {
    console.log(`${row.kind.padEnd(5)} ${row.id.padEnd(36)} hunks ${String(row.hunks).padStart(2)}  to Opus ${row.high}${row.faulty ? `  faulty: ${row.faulty.map((f) => `score ${f.score} -> T${f.tier} [${f.reasons}]`).join(" | ")}` : ""}`);
  }
  console.log(`\n${split}: routing recall ${r.faultyHigh}/${r.buggy}; hunks to Opus ${(r.opusShare * 100).toFixed(0)}% (clean cases ${(r.opusShareClean * 100).toFixed(0)}%)`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/tune.js")) main();
