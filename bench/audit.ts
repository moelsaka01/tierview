// P4-10: the hand audit of 20 judgements. No model calls.
//   node .bench-build/audit.js            -> bench/results/judge-audit.csv (for Mohamed to mark)
//   node .bench-build/audit.js --score    -> agreement rate from the marked CSV
// Sample: current judgements (judge v2) of current runs, stratified so that every kind of decision is checked, with a
// fixed seed; the arm and the reviewing model are left out so the auditor is blind to them.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_VERSION, type Judgement, auditSample } from "./judge";
import { loadCases } from "./routing";
import type { RunFile } from "./run";
import { BENCH } from "./lib/sh";

const RESULTS = join(BENCH, "results");
const CSV = join(RESULTS, "judge-audit.csv");

/** How many to draw from each kind of decision (20 in all). */
export const STRATA: { key: string; n: number; test: (j: Judgement) => boolean }[] = [
  { key: "rule match", n: 7, test: (j) => j.method === "rule" && j.verdict === "match" },
  { key: "model match", n: 2, test: (j) => j.method === "model" && j.verdict === "match" },
  { key: "model no match", n: 6, test: (j) => j.method === "model" && j.verdict === "no_match" },
  { key: "rule no match, same file", n: 4, test: (j) => j.method === "rule" && j.verdict === "no_match" && !j.reason.startsWith("file ") },
  { key: "rule no match, other file", n: 1, test: (j) => j.method === "rule" && j.verdict === "no_match" && j.reason.startsWith("file ") },
];

export const csvCell = (s: string) => `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function currentJudgements(): Judgement[] {
  const runs = new Map<string, RunFile>();
  for (const f of readdirSync(join(RESULTS, "runs"))) {
    const r = JSON.parse(readFileSync(join(RESULTS, "runs", f), "utf8")) as RunFile;
    if (r.complete) runs.set(`${r.case_id}|${r.arm}`, r);
  }
  const all = readFileSync(join(RESULTS, "judgements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Judgement);
  const latest = new Map<string, Judgement>();
  for (const j of all) {
    const r = runs.get(`${j.case_id}|${j.arm}`);
    if (!r || (j.run_batch ?? j.batch) !== r.batch || (j.judge_version ?? 1) !== JUDGE_VERSION) continue;
    latest.set(`${j.case_id}|${j.arm}|${j.finding_id}`, j);
  }
  return [...latest.values()].sort((a, b) => `${a.case_id}|${a.arm}|${a.finding_id}`.localeCompare(`${b.case_id}|${b.arm}|${b.finding_id}`));
}

function write(): void {
  const cases = new Map(loadCases().map((x) => [x.c.id, x.c]));
  const runs = new Map<string, RunFile>();
  for (const f of readdirSync(join(RESULTS, "runs"))) {
    const r = JSON.parse(readFileSync(join(RESULTS, "runs", f), "utf8")) as RunFile;
    runs.set(`${r.case_id}|${r.arm}`, r);
  }
  const js = currentJudgements();
  const picked: { stratum: string; j: Judgement }[] = [];
  for (const s of STRATA) for (const j of auditSample(js.filter(s.test), s.n, 7)) picked.push({ stratum: s.key, j });
  const header = ["n", "case", "split", "bug (plain English)", "fix (commit subject)", "finding: location", "finding: title", "finding: explanation", "judge", "judge verdict", "judge reason", "your mark (agree / disagree / unsure)", "your note"];
  const lines = [header.map(csvCell).join(",")];
  picked.forEach(({ j }, i) => {
    const c = cases.get(j.case_id)!;
    const f = [...(runs.get(`${j.case_id}|${j.arm}`)?.review.findings ?? []), ...(runs.get(`${j.case_id}|${j.arm}`)?.review.refuted ?? [])].find((x) => x.id === j.finding_id);
    const loc = `${j.file}:${j.start_line}${j.end_line !== j.start_line ? `-${j.end_line}` : ""}${j.side === "old" ? " (deleted lines)" : ""}; faulty lines: ${c.faulty.map((x) => `${x.file.split("/").pop()}:${x.lines.join(",")}`).join("; ")}`;
    lines.push(
      [String(i + 1), j.case_id, c.split, c.fix?.bug ?? "", c.fix?.subject ?? "", loc, j.title, f?.explanation ?? "", j.method === "rule" ? "rule" : "Opus", j.verdict === "match" ? "same bug" : "not the bug", j.reason, "", ""].map(csvCell).join(","),
    );
  });
  writeFileSync(CSV, lines.join("\n") + "\n");
  const counts = STRATA.map((s) => `${s.key}: ${picked.filter((p) => p.stratum === s.key).length} of ${js.filter(s.test).length}`).join("; ");
  process.stderr.write(`wrote ${picked.length} judgements to bench/results/judge-audit.csv (${counts})\n`);
}

function score(): void {
  if (!existsSync(CSV)) throw new Error("no judge-audit.csv");
  const [header, ...rows] = parseCsv(readFileSync(CSV, "utf8")).filter((r) => r.length > 1);
  const col = header!.findIndex((h) => h.startsWith("your mark"));
  const marks = rows.map((r) => (r[col] ?? "").trim().toLowerCase()).filter(Boolean);
  const agree = marks.filter((m) => m.startsWith("agree")).length;
  const disagree = marks.filter((m) => m.startsWith("disagree")).length;
  const unsure = marks.length - agree - disagree;
  console.log(`marked ${marks.length} of ${rows.length}: agree ${agree}, disagree ${disagree}, unsure ${unsure}; agreement ${(agree + disagree) ? ((agree / (agree + disagree)) * 100).toFixed(0) : "n/a"}% of decided`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/audit.js")) (process.argv.includes("--score") ? score : write)();
