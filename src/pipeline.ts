// Orchestrates one review run. Spec: PLAN.md §3, §5–§7.
// Order (§6, whole-diff escalation): every Tier 1 batch first; then Tier 2 gets its own hunks plus everything Tier 1
// escalated, in as few calls as the batch limits allow; then Tier 3 likewise. When Tier 2 and Tier 3 run the same
// model (Fable off), they are one tier (tiers/collapse.ts) and Tier 1 escalates straight to it.
// Budget priority (§7): before Tier 1 runs, the calls and worst-case cost of the higher tiers' own hunks are held back,
// so a cap cuts low-risk hunks first.
import { Ledger, degradePlan, worstCase } from "./budget";
import type { Config } from "./config";
import { type Estimates, estimateTokens } from "./estimate";
import type { FileSource } from "./git";
import type { Effort, ReviewBackend, ReviewRequest, ReviewResult } from "./llm/backend";
import { type PrInfo, hunkBlock, sharedContext, systemPrompt, userMessage } from "./llm/prompts";
import { mergeFindings, toFinding } from "./merge";
import { type Prices, costOfModels, priceFor } from "./prices";
import { type CallRecord, buildReceipt } from "./receipt";
import { limitsFor, packHunks } from "./tiers/batch";
import { collapseTiers } from "./tiers/collapse";
import { contextFor } from "./tiers/context";
import { decideEscalation, ruleFor, sanitizeReview } from "./tiers/escalate";
import type { Finding, HunkReview, LlmTier, ModelSubstitution, Review, ScoredHunk } from "./types";

export interface PipelineInput {
  routed: ScoredHunk[];
  cfg: Config;
  backend: ReviewBackend;
  files: FileSource;
  prices: Prices;
  est: Estimates;
  maxCost: number | null;
  /** Hard cap on model calls (API requests or claude invocations). null = no cap. */
  maxCalls?: number | null;
  pr?: PrInfo;
  /** Substitutions decided before the run (Fable not enabled, PLAN §5a); reported for tiers that made calls. */
  substitutions?: ModelSubstitution[];
  warnings?: string[];
  now?: () => number;
}

export interface PipelineOutput {
  review: Review;
  /** Some hunks were dropped or not sent because of the budget (exit code 3). */
  budgetExhausted: boolean;
}

interface HunkState {
  hunk: ScoredHunk;
  /** Tiers this hunk went through, in order. */
  path: LlmTier[];
  findings: Finding[];
  notReviewed?: string;
}

const key = (t: LlmTier) => `tier${t}` as const;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runPipeline(x: PipelineInput): Promise<PipelineOutput> {
  const now = x.now ?? (() => performance.now());
  const t0 = now();
  const { backend, prices, est } = x;
  const warnings = [...(x.warnings ?? [])];
  const collapsed = collapseTiers(x.cfg, x.routed);
  const cfg = collapsed.cfg;
  const merged = collapsed.merged;
  if (merged && collapsed.routed.some((h, i) => h.tier !== x.routed[i]!.tier)) {
    warnings.push(`Tier 2 and Tier 3 both run ${cfg.models.tier3.model}, so they ran as one tier at ${cfg.models.tier3.effort} effort.`);
  }

  let routed = collapsed.routed;
  let degraded = false;
  const budgetDropped = new Set<string>();
  if (x.maxCost !== null) {
    const d = degradePlan(routed, cfg, prices, est, x.maxCost, backend.name);
    routed = d.routed;
    degraded = d.degraded;
    for (const id of d.dropped) budgetDropped.add(id);
    if (d.degraded) warnings.push(`plan degraded to fit --max-cost: ${d.moves.join("; ")}.`);
  }

  const ledger = new Ledger(x.maxCost);
  const shared = sharedContext(routed, x.pr);
  const state = new Map<string, HunkState>();
  for (const h of routed) if (h.tier !== 0) state.set(h.id, { hunk: h, path: [], findings: [] });
  const records: CallRecord[] = [];
  const refutedBy = new Map<string, LlmTier>();
  const escalatedIn: Record<LlmTier, number> = { 1: 0, 2: 0, 3: 0 };
  const fileCache = new Map<string, string | null>();
  const fileText = (p: string) => {
    if (!fileCache.has(p)) fileCache.set(p, x.files(p));
    return fileCache.get(p) ?? null;
  };
  let budgetStopped = false;
  let callsUsed = 0;
  const maxCalls = x.maxCalls ?? null;

  /** Packs and worst case of one tier over `ids`, without sending anything. */
  function planTier(tier: LlmTier, ids: string[]): { packs: number; worst: number } {
    if (!ids.length) return { packs: 0, worst: 0 };
    const m = cfg.models[key(tier)];
    const blocks = new Map(ids.map((id) => {
      const s = state.get(id)!;
      return [id, hunkBlock({ hunk: s.hunk, context: contextFor(s.hunk, tier, fileText(s.hunk.file)), prior: [] })] as const;
    }));
    const packs = packHunks(ids.map((id) => state.get(id)!.hunk), limitsFor(backend.name, tier, cfg, est), (h) => estimateTokens(blocks.get(h.id)!, est));
    const maxTokens = backend.name === "api" ? cfg.backend.api.max_tokens : 32000;
    const prefix = estimateTokens(systemPrompt(tier) + shared, est);
    const worst = packs.reduce((a, p) => a + worstCase(prefix + p.reduce((b, h) => b + estimateTokens(blocks.get(h.id)!, est), 0), maxTokens, priceFor(m.model, prices)), 0);
    return { packs: packs.length, worst };
  }

  /** Calls held back for the higher tiers while Tier 1 runs (--max-calls priority). */
  let heldCalls = 0;

  /** Runs one tier over `ids` (`escalated`: the ids that came up from a lower tier). Returns each hunk's review, or null with the failure reason. */
  async function runTier(tier: LlmTier, ids: string[], escalated: Set<string>): Promise<Map<string, { review: HunkReview | null; failure?: string }>> {
    const results = new Map<string, { review: HunkReview | null; failure?: string }>();
    if (!ids.length) return results;
    const m = cfg.models[key(tier)];
    const system = systemPrompt(tier);
    const blocks = new Map<string, string>();
    for (const id of ids) {
      const s = state.get(id)!;
      blocks.set(id, hunkBlock({ hunk: s.hunk, context: contextFor(s.hunk, tier, fileText(s.hunk.file)), prior: s.findings }));
    }
    const hunks = ids.map((id) => state.get(id)!.hunk);
    // Packs holding the tier's own hunks go first, so a call cap cuts escalations before routed hunks.
    const onlyEscalated = (p: ScoredHunk[]) => (p.every((h) => escalated.has(h.id)) ? 1 : 0);
    const packs = packHunks(hunks, limitsFor(backend.name, tier, cfg, est), (h) => estimateTokens(blocks.get(h.id)!, est)).sort((a, b) => onlyEscalated(a) - onlyEscalated(b));
    const prefixTokens = estimateTokens(system + shared, est);
    const cache = backend.name === "api" && packs.length >= 2 && prefixTokens >= 512;
    const maxTokens = backend.name === "api" ? cfg.backend.api.max_tokens : 32000;
    const price = priceFor(m.model, prices);

    const send = async (pack: ScoredHunk[]) => {
      const packIds = pack.map((h) => h.id);
      const user = userMessage(packIds.map((id) => blocks.get(id)!), packIds);
      if (maxCalls !== null && callsUsed >= maxCalls - heldCalls) {
        budgetStopped = true;
        for (const id of packIds) results.set(id, { review: null, failure: "budget" });
        return;
      }
      const ticket = ledger.reserve(worstCase(prefixTokens + estimateTokens(user, est), maxTokens, price));
      if (ticket === null) {
        budgetStopped = true;
        for (const id of packIds) results.set(id, { review: null, failure: "budget" });
        return;
      }
      const req: ReviewRequest = {
        tier,
        model: m.model,
        effort: m.effort as Effort,
        system,
        shared,
        user,
        hunkIds: packIds,
        cache,
        maxTokens,
        fallbackModel: backend.name === "claude-code" && tier === 3 ? cfg.models.tier2.model : undefined,
      };
      let res: ReviewResult;
      try {
        res = await backend.review(req);
      } catch (e) {
        ledger.settle(ticket, 0);
        throw e;
      }
      callsUsed += res.calls;
      const { cost } = costOfModels(res.usageByModel, prices);
      ledger.settle(ticket, cost);
      records.push({ tier, requested: m.model, model: res.model, hunkIds: packIds, usageByModel: res.usageByModel, calls: res.calls, cost, escalation: packIds.some((id) => escalated.has(id)) });
      if (!res.ok) warnings.push(`tier ${tier} call failed for ${packIds.join(", ")}: ${res.reason}: ${res.detail.slice(0, 300)}`);
      for (const id of packIds) {
        if (!res.ok) {
          results.set(id, { review: null, failure: `${res.reason}: ${res.detail}` });
          continue;
        }
        const raw = res.response.reviews.find((rv) => rv.hunk_id === id);
        const r = raw ? sanitizeReview(raw) : null;
        results.set(id, r ? { review: r } : { review: null, failure: "missing from the response" });
        if (r) {
          const s = state.get(id)!;
          for (const ref of r.refuted_prior) {
            const prev = refutedBy.get(ref);
            if (prev === undefined || prev < tier) refutedBy.set(ref, tier);
          }
          s.findings.push(...r.findings.map((f) => toFinding(f, id, res.model, tier, s.path.filter((p): p is 1 | 2 => p < tier))));
        }
      }
    };

    // API caching rule (§5): send the first request, await it, then fan out so the rest read the cache.
    const [first, ...rest] = packs;
    if (cache && first) {
      await send(first);
      await mapLimit(rest, backend.concurrency, send);
    } else {
      await mapLimit(packs, backend.concurrency, send);
    }
    for (const id of ids) state.get(id)!.path.push(tier);
    return results;
  }

  const initial = (t: LlmTier) => routed.filter((h) => h.tier === t).map((h) => h.id);
  const failures = new Map<string, string>();
  const collect = (res: Map<string, { review: HunkReview | null; failure?: string }>) => {
    for (const [id, r] of res) if (!r.review) failures.set(id, r.failure ?? "failed");
    return res;
  };

  // Hold the higher tiers' own hunks' calls and worst-case cost while Tier 1 runs, so a cap cuts low risk first.
  const higher = [planTier(2, initial(2)), planTier(3, initial(3))];
  heldCalls = higher.reduce((a, h) => a + h.packs, 0);
  const holdCost = higher.reduce((a, h) => a + h.worst, 0);
  const hold = holdCost > 0 ? ledger.reserve(holdCost) : null;
  const r1 = collect(await runTier(1, initial(1), new Set()));
  heldCalls = 0;
  if (hold !== null) ledger.settle(hold, 0);

  const escalate = (res: Map<string, { review: HunkReview | null; failure?: string }>, from: 1 | 2) => {
    const rule = ruleFor(from, cfg);
    const up: string[] = [];
    for (const [id, r] of res) {
      if (r.failure === "budget") continue;
      if (decideEscalation(r.review, state.get(id)!.hunk, rule, r.failure).escalate) up.push(id);
    }
    return up;
  };

  // Whole-diff escalation: one round per tier, the tier's own hunks and every escalated hunk together.
  const up1 = escalate(r1, 1);
  for (const id of up1) failures.delete(id);
  let r2 = new Map<string, { review: HunkReview | null; failure?: string }>();
  let up2: string[] = [];
  if (!merged) {
    escalatedIn[2] = up1.length;
    // Same priority rule one level up: Tier 3's own hunks keep their calls and budget while Tier 2 runs.
    const t3 = planTier(3, initial(3));
    heldCalls = t3.packs;
    const hold3 = t3.worst > 0 ? ledger.reserve(t3.worst) : null;
    r2 = collect(await runTier(2, [...initial(2), ...up1], new Set(up1)));
    heldCalls = 0;
    if (hold3 !== null) ledger.settle(hold3, 0);
    up2 = escalate(r2, 2);
    for (const id of up2) failures.delete(id);
  }
  const into3 = merged ? up1 : up2;
  escalatedIn[3] = into3.length;
  const r3 = collect(await runTier(3, [...initial(3), ...into3], new Set(into3)));

  // Hunks still failed after their last tier: a Tier 3 failure, or a failure that could not escalate (budget).
  const reviewedOnce = new Set<string>();
  for (const res of [r1, r2, r3]) for (const [id, r] of res) if (r.review) reviewedOnce.add(id);
  const blocked: string[] = [];
  for (const [id, why] of failures) {
    if (why === "budget" && reviewedOnce.has(id)) {
      blocked.push(id);
      continue;
    }
    state.get(id)!.notReviewed = why === "budget" ? "budget" : `tier ${state.get(id)!.path.at(-1)} ${why}`;
  }
  if (blocked.length) warnings.push(`escalation not sent (budget or --max-calls), lower-tier review kept: ${blocked.sort().join(", ")}.`);

  const notReviewed = [
    ...[...budgetDropped].map((id) => ({ hunk_id: id, reason: "budget" })),
    ...[...state.values()].filter((s) => s.notReviewed).map((s) => ({ hunk_id: s.hunk.id, reason: s.notReviewed! })),
  ].sort((a, b) => a.hunk_id.localeCompare(b.hunk_id));

  const { findings, refuted } = mergeFindings(
    [...state.values()].flatMap((s) => s.findings),
    refutedBy,
  );

  const subs = [...(x.substitutions ?? []).filter((s) => records.some((r) => r.tier === s.tier)), ...backend.substitutions()];
  if (backend.name === "claude-code") {
    warnings.push("claude-code backend: costs are API-equivalent (tokens at API list prices), not what your Claude plan bills.");
    if (process.env.ANTHROPIC_API_KEY) warnings.push("ANTHROPIC_API_KEY is set, so Claude Code may bill that key instead of your plan.");
    if (records.some((r) => /fable/i.test(r.model))) warnings.push("Fable ran through Claude Code. On some plans Fable draws on usage credits, and `claude -p` does not ask first.");
  }

  const receipt = buildReceipt({
    backend: backend.name,
    cfg,
    prices,
    est,
    routed,
    records,
    escalatedIn,
    merged,
    skipped: routed.filter((h) => h.tier === 0).length - budgetDropped.size,
    notReviewed: notReviewed.length,
    maxCost: x.maxCost,
    degraded,
    substitutions: subs,
    warnings,
    wallMs: now() - t0,
  });

  const review: Review = {
    version: 1,
    findings,
    refuted,
    not_reviewed: notReviewed,
    routing: routed.map((h) => ({ hunk_id: h.id, score: h.score, tier: h.tier, reasons: h.reasons })),
    receipt,
  };
  return { review, budgetExhausted: budgetDropped.size > 0 || budgetStopped };
}
