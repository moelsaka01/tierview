// Tier 0 routing over the benchmark cases: no model calls. Spec: PLAN.md §9 ("routing recall").
// A buggy case's faulty hunks are the hunks of its diff that contain a faulty line (a line of B that F rewrote).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { parseDiff } from "../src/tier0/diff";
import { routeDiff } from "../src/tier0/route";
import type { Hunk, ScoredHunk } from "../src/types";
import type { BenchCase } from "./validate";
import { BENCH } from "./lib/sh";

/** Hunks whose new-side range holds at least one faulty line. */
export function faultyHunks<H extends Hunk>(hunks: H[], faulty: BenchCase["faulty"]): H[] {
  return hunks.filter((h) =>
    faulty.some((f) => f.file === h.file && f.lines.some((l) => l >= h.newStart && l < h.newStart + Math.max(h.newLines, 1))),
  );
}

export interface CaseRouting {
  id: string;
  kind: BenchCase["kind"];
  hunks: number;
  tiers: Record<0 | 1 | 2 | 3, number>;
  /** Highest tier a faulty hunk was routed to (buggy cases), null if no hunk holds a faulty line. */
  faultyTier: number | null;
  faultyScores: number[];
}

export function routeCase(c: BenchCase, diff: string, cfg: Config): CaseRouting {
  const routed: ScoredHunk[] = routeDiff(parseDiff(diff), cfg, null);
  const tiers = { 0: 0, 1: 0, 2: 0, 3: 0 } as CaseRouting["tiers"];
  for (const h of routed) tiers[h.tier]++;
  const fh = faultyHunks(routed, c.faulty);
  return { id: c.id, kind: c.kind, hunks: routed.length, tiers, faultyTier: fh.length ? Math.max(...fh.map((h) => h.tier)) : null, faultyScores: fh.map((h) => h.score) };
}

export function loadCases(): { c: BenchCase; diff: string }[] {
  const dir = join(BENCH, "cases");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ c: JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchCase, diff: readFileSync(join(dir, f.replace(/\.json$/, ".diff")), "utf8") }));
}

function main(): void {
  const cfg = loadConfig({ cwd: BENCH });
  const rows = loadCases().map(({ c, diff }) => ({ c, r: routeCase(c, diff, cfg) }));
  for (const { c, r } of rows) {
    console.log(`${c.split.padEnd(4)} ${c.kind.padEnd(5)} ${c.id.padEnd(38)} hunks ${String(r.hunks).padStart(2)}  T0/1/2/3 ${r.tiers[0]}/${r.tiers[1]}/${r.tiers[2]}/${r.tiers[3]}${c.kind === "buggy" ? `  faulty -> tier ${r.faultyTier ?? "?"} (score ${r.faultyScores.join(",")})` : ""}`);
  }
  const buggy = rows.filter((x) => x.c.kind === "buggy");
  const high = buggy.filter((x) => (x.r.faultyTier ?? 0) >= 2).length;
  console.log(`\nrouting recall (faulty hunk at tier >= 2): ${high}/${buggy.length}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/routing.js")) main();
