// Plain-text terminal output (no colour, so it is stable in logs and snapshots).
import type { Plan } from "../estimate";
import type { ScoredHunk } from "../types";

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
  out.push(`tierview dry run: ${routed.length} hunk(s) in ${new Set(routed.map((h) => h.file)).size} file(s). No API calls made.`, "");

  const order = [...routed].sort((a, b) => (a.tier === 0 ? 1 : 0) - (b.tier === 0 ? 1 : 0) || b.score - a.score || a.id.localeCompare(b.id));
  out.push("Routing (highest risk first)");
  out.push(
    ...table(
      [["hunk", "+/-", "score", "tier", "why"], ...order.map((h) => [h.id, `+${h.added}/-${h.deleted}`, String(h.score), h.tier === 0 ? "skip" : String(h.tier), h.tier === 0 ? h.reasons.at(-1)?.detail ?? "skipped" : why(h)])],
      [2],
    ).map((l) => `  ${l}`),
  );

  out.push("", "Estimated cost (no caching discount, before escalations)");
  const rows = [["tier", "model", "effort", "hunks", "requests", "input tok", "output tok", "cost"]];
  for (const t of plan.tiers) {
    rows.push([String(t.tier), t.model, t.effort, String(t.hunks), String(t.requests), String(t.input_tokens), String(t.output_tokens), usd(t.cost_usd)]);
  }
  out.push(...table(rows, [3, 4, 5, 6, 7]).map((l) => `  ${l}`));
  out.push("");
  out.push(`  skipped hunks:        ${plan.skipped_hunks}`);
  out.push(`  estimated total:      ${usd(plan.total_usd)} (+ up to ${usd(plan.reserve_usd)} escalation allowance)`);
  out.push(`  all-${plan.baseline.model} baseline: ${usd(plan.baseline.cost_usd)} (${plan.baseline.method})`);
  out.push(`  estimated savings:    ${plan.savings_pct}%`);
  if (v.maxCost !== null) out.push(`  --max-cost:           ${usd(v.maxCost)}${plan.total_usd + plan.reserve_usd > v.maxCost ? " (this plan would be degraded to fit)" : ""}`);

  if (v.warnings.length) out.push("", "Notes", ...v.warnings.map((w) => `  - ${w}`));
  return out.join("\n") + "\n";
}
