// One summary PR comment: ranked findings plus the cost receipt; updated in place on re-runs. Spec: PLAN.md §10.
import { usd } from "../output/terminal";
import type { Review } from "../types";
import { type FetchLike, type PrRef, apiBase, ghRequest } from "./pr";

export const MARKER = "<!-- tierview-review -->";
const MAX_BODY = 60000; // GitHub's limit is 65536 characters.

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const indent = (s: string) => s.replace(/\n/g, "\n  ");

export function renderComment(r: Review): string {
  const rc = r.receipt;
  const apiEq = rc.cost_basis === "api_equivalent";
  const out: string[] = [MARKER, "## tierview review", ""];
  out.push(r.findings.length ? `**${r.findings.length} finding(s)**` : "**No findings.**", "");
  for (const f of r.findings) {
    const lines = f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`;
    out.push(`- **${f.severity}** \`${f.file}:${lines}\`${f.side === "old" ? " (deleted line)" : ""}: ${f.title}`);
    out.push(`  <details><summary>details</summary>\n\n  ${f.category}, confidence ${f.confidence.toFixed(2)}, tier ${f.tier} (${f.model})\n\n  ${indent(f.explanation)}${f.suggestion ? `\n\n  Suggestion: ${indent(f.suggestion)}` : ""}\n  </details>`);
  }
  if (r.findings.length) out.push("");
  if (r.not_reviewed.length) out.push(`${r.not_reviewed.length} hunk(s) not reviewed (${[...new Set(r.not_reviewed.map((x) => x.reason))].join("; ")}).`, "");
  out.push("### Cost receipt", "");
  out.push("| tier | model | effort | hunks | calls | cost |", "|---:|---|---|---:|---:|---:|");
  for (const t of rc.tiers) out.push(`| ${t.tier} | ${cell(t.model)} | ${t.effort} | ${t.hunks + t.escalated_in} | ${t.requests} | ${usd(t.cost_usd)} |`);
  out.push("");
  out.push(
    `**Total ${usd(rc.total_cost_usd)}** (${rc.calls} request(s), ${apiEq ? "API-equivalent" : "list prices"} as of ${rc.prices_as_of}). The same tokens at ${rc.baseline.model} rates would cost ${usd(rc.baseline.cost_usd)} (${rc.savings_pct}% ${rc.savings_pct >= 0 ? "less" : "more"}; calculated, not measured).`,
  );
  if (rc.budget.max_cost_usd !== null) out.push(`Budget cap: ${usd(rc.budget.max_cost_usd)}${rc.budget.degraded ? " (plan degraded to fit)" : ""}.`);
  if (rc.warnings.length) out.push("", ...rc.warnings.map((w) => `> ${w}`));
  out.push("", "<sub>AI review can be wrong; treat findings as leads, not verdicts.</sub>");
  const body = out.join("\n");
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_(truncated)_` : body;
}

/** Create the summary comment, or update the previous one (found by its marker). */
export async function upsertComment(ref: PrRef, body: string, token: string, f: FetchLike = fetch as unknown as FetchLike): Promise<{ url: string; updated: boolean }> {
  const base = `${apiBase()}/repos/${ref.owner}/${ref.repo}`;
  let existing: number | null = null;
  for (let page = 1; page <= 10 && existing === null; page++) {
    const list = JSON.parse(await ghRequest(f, `${base}/issues/${ref.number}/comments?per_page=100&page=${page}`, token)) as { id: number; body?: string }[];
    existing = list.find((c) => c.body?.includes(MARKER))?.id ?? null;
    if (list.length < 100) break;
  }
  const payload = JSON.stringify({ body });
  const res = existing
    ? await ghRequest(f, `${base}/issues/comments/${existing}`, token, undefined, { method: "PATCH", body: payload })
    : await ghRequest(f, `${base}/issues/${ref.number}/comments`, token, undefined, { method: "POST", body: payload });
  return { url: (JSON.parse(res) as { html_url?: string }).html_url ?? "", updated: existing !== null };
}
