// Plain-text terminal output (no colour, so it is stable in logs and snapshots).
import type { Plan } from "../estimate";
import { substitutionLine } from "../fable";
import type { Receipt, Review, ScoredHunk } from "../types";

export const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

function table(rows: string[][], right: number[] = []): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) =>
    r
      .map((cell, c) => (right.includes(c) ? cell.padStart(widths[c]!) : c === r.length - 1 ? cell : cell.padEnd(widths[c]!)))
      .join("  ")
      .trimEnd(),
  );
}

function why(h: ScoredHunk): string {
  const parts = h.reasons.filter((r) => r.weight !== 0 || r.signal !== "size").map((r) => (r.weight ? `${r.signal} ${r.weight > 0 ? "+" : ""}${r.weight}` : `${r.signal}: ${r.detail}`));
  return parts.join(", ") || "no signals";
}

export interface DryRunView {
  routed: ScoredHunk[];
  plan: Plan;
  warnings: string[];
  maxCost: number | null;
}

export function renderDryRun(v: DryRunView): string {
  const out: string[] = [];
  const { routed, plan } = v;
  out.push(`tierview dry run: ${routed.length} hunk(s) in ${new Set(routed.map((h) => h.file)).size} file(s). No model calls made.`, "");

  const order = [...routed].sort((a, b) => (a.tier === 0 ? 1 : 0) - (b.tier === 0 ? 1 : 0) || b.score - a.score || a.id.localeCompare(b.id));
  out.push("Routing (highest risk first)");
  out.push(
    ...table(
      [["hunk", "+/-", "score", "tier", "why"], ...order.map((h) => [h.id, `+${h.added}/-${h.deleted}`, String(h.score), h.tier === 0 ? "skip" : String(h.tier), h.tier === 0 ? h.reasons.at(-1)?.detail ?? "skipped" : why(h)])],
      [2],
    ).map((l) => `  ${l}`),
  );

  out.push("", plan.backend === "claude-code" ? "Estimated API-equivalent cost (claude-code backend; requests = claude calls; no caching discount, before escalations)" : "Estimated cost (no caching discount, before escalations)");
  const rows = [["tier", "model", "effort", "hunks", "requests", "input tok", "output tok", "cost"]];
  for (const t of plan.tiers) {
    rows.push([String(t.tier), t.model, t.effort, String(t.hunks), String(t.requests), String(t.input_tokens), String(t.output_tokens), usd(t.cost_usd)]);
  }
  out.push(...table(rows, [3, 4, 5, 6, 7]).map((l) => `  ${l}`));
  out.push("");
  out.push(`  skipped hunks:        ${plan.skipped_hunks}`);
  const cc = plan.backend === "claude-code";
  out.push(`  estimated total:      ${usd(plan.total_usd)}${cc ? " via Claude Code" : ""} (+ up to ${usd(plan.reserve_usd)} escalation allowance)`);
  if (cc) out.push(`  direct API:           ${usd(plan.total_direct_api_usd)} (without Claude Code's per-call overhead)`);
  out.push(`  all-${plan.baseline.model}: ${usd(plan.baseline.cost_usd)}${cc ? ` via Claude Code, ${usd(plan.baseline.direct_api_cost_usd)} direct API` : ""} (the same estimated tokens at its rates)`);
  out.push(`  estimated savings:    ${plan.savings_pct}%`);
  if (v.maxCost !== null) out.push(`  --max-cost:           ${usd(v.maxCost)}${plan.total_usd + plan.reserve_usd > v.maxCost ? " (this plan would be degraded to fit)" : ""}`);

  if (v.warnings.length) out.push("", "Notes", ...v.warnings.map((w) => `  - ${w}`));
  return out.join("\n") + "\n";
}

// ---- Full review --------------------------------------------------------

const n = (x: number) => x.toLocaleString("en-US");

export function renderReceipt(r: Receipt): string[] {
  const apiEq = r.cost_basis === "api_equivalent";
  const out: string[] = [];
  out.push(apiEq ? `Receipt (claude-code backend: ${r.calls} claude call(s); cost is API-equivalent at list prices as of ${r.prices_as_of}, not what your plan bills)` : `Receipt (api backend: ${r.calls} request(s); list prices as of ${r.prices_as_of})`);
  const rows = [["tier", "model", "effort", "hunks", "+escalated", apiEq ? "calls" : "requests", "input", "cache write", "cache read", "output", apiEq ? "via Claude Code" : "cost", ...(apiEq ? ["direct API"] : [])]];
  for (const t of r.tiers) {
    rows.push([String(t.tier), t.model, t.effort, String(t.hunks), String(t.escalated_in), String(t.requests), n(t.input_tokens), n(t.cache_write_tokens), n(t.cache_read_tokens), n(t.output_tokens), usd(t.cost_usd), ...(apiEq ? [usd(t.direct_api_cost_usd)] : [])]);
  }
  out.push(...table(rows, [3, 4, 5, 6, 7, 8, 9, 10, 11]).map((l) => `  ${l}`));
  const tok = r.tiers.reduce((a, t) => a + t.input_tokens + t.cache_write_tokens + t.cache_read_tokens + t.output_tokens, 0);
  out.push("");
  out.push(`  total:                ${usd(r.total_cost_usd)}${apiEq ? ` via Claude Code, ${usd(r.total_direct_api_cost_usd)} direct API (without Claude Code's per-call overhead)` : ""} (${n(tok)} tokens)`);
  out.push(`  all-${r.baseline.model}: ${usd(r.baseline.cost_usd)}${apiEq ? ` via Claude Code, ${usd(r.baseline.direct_api_cost_usd)} direct API` : ""} (the same tokens at its rates) -> ${r.savings_pct}% ${r.savings_pct >= 0 ? "less" : "more"}`);
  out.push(`  skipped hunks: ${r.skipped_hunks}   not reviewed: ${r.not_reviewed_hunks}   wall time: ${(r.wall_ms / 1000).toFixed(1)}s`);
  if (r.budget.max_cost_usd !== null) out.push(`  --max-cost: ${usd(r.budget.max_cost_usd)}${r.budget.degraded ? " (plan degraded to fit)" : ""}`);
  for (const s of r.model_substitutions) out.push(`  ${substitutionLine(s)}`);
  return out;
}

export function renderReview(v: Review): string {
  const out: string[] = [];
  const reviewed = v.routing.filter((h) => h.tier !== 0).length;
  out.push(`tierview: ${v.findings.length} finding(s) in ${reviewed} reviewed hunk(s).`, "");
  for (const f of v.findings) {
    const lines = f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`;
    out.push(`[${f.severity}] ${f.file}:${lines}${f.side === "old" ? " (deleted line)" : ""}  ${f.title}`);
    out.push(`  ${f.category}, confidence ${f.confidence.toFixed(2)}, tier ${f.tier} ${f.model}${f.escalated_from.length ? ` (escalated from tier ${f.escalated_from.join(", ")})` : ""}`);
    if (f.explanation) out.push(`  ${f.explanation}`);
    if (f.evidence) out.push(`  > ${f.evidence}`);
    if (f.suggestion) out.push(`  fix: ${f.suggestion}`);
    if (f.also_reported_by.length) out.push(`  also reported by: ${f.also_reported_by.join(", ")}`);
    out.push("");
  }
  if (v.refuted.length) out.push(`${v.refuted.length} lower-tier finding(s) refuted by a higher tier (see --json).`, "");
  if (v.not_reviewed.length) {
    out.push("Not reviewed");
    for (const x of v.not_reviewed) out.push(`  ${x.hunk_id}: ${x.reason}`);
    out.push("");
  }
  out.push(...renderReceipt(v.receipt));
  if (v.receipt.warnings.length) out.push("", "Notes", ...v.receipt.warnings.map((w) => `  - ${w}`));
  return out.join("\n") + "\n";
}
