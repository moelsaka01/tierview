// P4-11: bench/results/chart.svg from bench/results/results-test.json. No model calls, no dependencies.
//   node .bench-build/chart.js
// Recall (y) vs API-equivalent cost per case via Claude Code (x), one point per arm, vertical 95% bootstrap ranges.
// Light and dark via prefers-color-scheme inside the SVG; colors from the dataviz reference palette (validated:
// categorical slots 1-3; the light aqua is under 3:1, so every point also carries a direct text label).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Results } from "./metrics";
import { BENCH } from "./lib/sh";

const ARM_STYLE: Record<string, { cls: string; label: string }> = {
  tierview: { cls: "s1", label: "tierview" },
  "all-opus": { cls: "s2", label: "all-Opus" },
  "all-sonnet": { cls: "s3", label: "all-Sonnet" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function chartSvg(r: Results): string {
  const W = 680;
  const H = 420;
  const m = { top: 70, right: 150, bottom: 56, left: 64 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const arms = r.arms.filter((a) => a.arm in ARM_STYLE);
  const maxCost = Math.max(...arms.map((a) => a.mean_cost_via_claude_code_usd));
  const xMax = Math.ceil((maxCost * 1.15) / 0.05) * 0.05;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const x = (v: number) => r1(m.left + (v / xMax) * pw);
  const y = (v: number) => r1(m.top + (1 - v) * ph);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">`);
  out.push(`<title id="t">Bugs caught vs cost per case, test split</title>`);
  out.push(
    `<desc id="d">${esc(arms.map((a) => `${ARM_STYLE[a.arm]!.label}: ${a.caught} of ${a.buggy_runs} bugs (${Math.round(a.recall * 100)}%, 95% range ${Math.round(a.recall_ci95[0] * 100)}-${Math.round(a.recall_ci95[1] * 100)}%), $${a.mean_cost_via_claude_code_usd.toFixed(3)} per case`).join("; "))}.</desc>`,
  );
  out.push(`<style>
  .bg{fill:#fcfcfb} .t1{fill:#0b0b0b} .t2{fill:#52514e} .grid{stroke:#e4e3df} .axis{stroke:#8c8b85}
  .s1{fill:#2a78d6;stroke:#2a78d6} .s2{fill:#eb6834;stroke:#eb6834} .s3{fill:#1baf7a;stroke:#1baf7a} .ring{stroke:#fcfcfb}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19} .t1{fill:#f0efec} .t2{fill:#c3c2b7} .grid{stroke:#33332f} .axis{stroke:#6f6e68}
    .s1{fill:#3987e5;stroke:#3987e5} .s2{fill:#d95926;stroke:#d95926} .s3{fill:#199e70;stroke:#199e70} .ring{stroke:#1a1a19}
  }
  text{font-size:12px} .h{font-size:15px;font-weight:600} .lab{font-size:12.5px;font-weight:600}
</style>`);
  out.push(`<rect class="bg" x="0" y="0" width="${W}" height="${H}" rx="8"/>`);
  out.push(`<text class="t1 h" x="${m.left}" y="26">Bugs caught vs cost per case (test split, ${arms[0]?.buggy_runs ?? 0} bugs)</text>`);
  out.push(`<text class="t2" x="${m.left}" y="46">Bars: 95% bootstrap ranges · cost via Claude Code · tierview vs all-Opus: p = ${r.mcnemar_tierview_vs_all_opus?.p ?? "n/a"}</text>`);
  // grid and axes
  for (let v = 0; v <= 1.0001; v += 0.25) {
    out.push(`<line class="grid" x1="${m.left}" x2="${m.left + pw}" y1="${y(v)}" y2="${y(v)}" stroke-width="1"/>`);
    out.push(`<text class="t2" x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`);
  }
  for (let v = 0; v <= xMax + 1e-9; v += 0.05) {
    out.push(`<text class="t2" x="${x(v)}" y="${m.top + ph + 18}" text-anchor="middle">$${v.toFixed(2)}</text>`);
  }
  out.push(`<line class="axis" x1="${m.left}" x2="${m.left + pw}" y1="${m.top + ph}" y2="${m.top + ph}" stroke-width="1"/>`);
  out.push(`<text class="t2" x="${m.left + pw / 2}" y="${H - 14}" text-anchor="middle">API-equivalent cost per case (USD, via Claude Code)</text>`);
  out.push(`<text class="t2" transform="translate(16 ${m.top + ph / 2}) rotate(-90)" text-anchor="middle">bugs caught (recall)</text>`);
  // points, ranges, direct labels
  const xs = arms.map((a) => x(a.mean_cost_via_claude_code_usd));
  for (const a of arms) {
    const s = ARM_STYLE[a.arm]!;
    const cx = x(a.mean_cost_via_claude_code_usd);
    // Label on the right unless another arm's range bar sits within the label's width there.
    const left = xs.some((o) => o > cx && o - cx < 150);
    const lx = left ? cx - 14 : cx + 14;
    const anchor = left ? ' text-anchor="end"' : "";
    const [lo, hi] = a.recall_ci95;
    out.push(`<g><title>${esc(`${s.label}: ${a.caught}/${a.buggy_runs} bugs (${Math.round(a.recall * 100)}%), 95% range ${Math.round(lo * 100)}-${Math.round(hi * 100)}%; $${a.mean_cost_via_claude_code_usd.toFixed(3)} per case via Claude Code, $${a.mean_cost_direct_api_usd.toFixed(3)} direct API; false alarms on ${a.clean_cases_with_fp}/${a.clean_runs} clean cases`)}</title>`);
    out.push(`<line class="${s.cls}" x1="${cx}" x2="${cx}" y1="${y(lo)}" y2="${y(hi)}" stroke-width="2" stroke-linecap="round"/>`);
    for (const v of [lo, hi]) out.push(`<line class="${s.cls}" x1="${cx - 6}" x2="${cx + 6}" y1="${y(v)}" y2="${y(v)}" stroke-width="2" stroke-linecap="round"/>`);
    out.push(`<circle class="${s.cls} ring" cx="${cx}" cy="${y(a.recall)}" r="7" stroke-width="2"/>`);
    out.push(`<text class="t1 lab" x="${lx}" y="${y(a.recall) - 2}"${anchor}>${esc(s.label)}</text>`);
    out.push(`<text class="t2" x="${lx}" y="${y(a.recall) + 14}"${anchor}>${a.caught}/${a.buggy_runs} · $${a.mean_cost_via_claude_code_usd.toFixed(3)} · FP ${a.clean_cases_with_fp}/${a.clean_runs}</text></g>`);
  }
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

function main(): void {
  const r = JSON.parse(readFileSync(join(BENCH, "results", "results-test.json"), "utf8")) as Results;
  writeFileSync(join(BENCH, "results", "chart.svg"), chartSvg(r));
  process.stderr.write("wrote bench/results/chart.svg\n");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/chart.js")) main();
