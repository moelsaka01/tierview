// P4-09 helper: compare weight / threshold variants on the dev split. No model calls.
//   node .bench-build/tune-grid.js
import { type Config, loadConfig } from "../src/config";
import { tuneReport } from "./tune";
import { BENCH } from "./lib/sh";

const base = loadConfig({ cwd: BENCH });
const v = (boundary: number, memory: number, t2: number): Config => ({
  ...base,
  thresholds: { ...base.thresholds, tier2: t2 },
  categories: { ...base.categories, boundary: { ...base.categories.boundary!, weight: boundary }, memory: { ...base.categories.memory!, weight: memory } },
});

console.log("boundary memory opus-threshold | dev recall | hunks to Opus (all / clean)");
for (const t2 of [30, 25, 20]) {
  for (const [b, m] of [[10, 0], [20, 0], [20, 20], [25, 25], [30, 25]] as const) {
    const r = tuneReport(v(b, m, t2), "dev");
    console.log(`${String(b).padStart(8)} ${String(m).padStart(6)} ${String(t2).padStart(14)} | ${r.faultyHigh}/${r.buggy}        | ${(r.opusShare * 100).toFixed(0)}% / ${(r.opusShareClean * 100).toFixed(0)}%`);
  }
}
