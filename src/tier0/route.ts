// Score -> tier. Spec: PLAN.md §4 "Routing thresholds". Order: ignore globs, then rules[] (add, then min/max tier).
import picomatch from "picomatch";
import type { Config } from "../config";
import type { Churn } from "../git";
import type { Hunk, LlmTier, Reason, ScoredHunk, Tier } from "../types";
import { scoreHunks, type Unrouted } from "./score";
import { compileRules, type Rules } from "./signals";

export function tierForScore(score: number, cfg: Config): LlmTier {
  return score >= cfg.thresholds.tier3 ? 3 : score >= cfg.thresholds.tier2 ? 2 : 1;
}

export function routeHunks(scored: Unrouted[], cfg: Config): ScoredHunk[] {
  const ignore = cfg.ignore.length ? picomatch(cfg.ignore, { dot: true }) : () => false;
  const rules = cfg.rules.map((r) => ({ rule: r, match: picomatch(r.paths, { dot: true }) }));
  return scored.map((h): ScoredHunk => {
    if (h.fileKind === "generated") return { ...h, tier: 0 };
    if (ignore(h.file)) {
      return { ...h, tier: 0, reasons: [...h.reasons, { signal: "ignore", weight: 0, detail: "matches an `ignore` glob" }] };
    }
    const reasons: Reason[] = [...h.reasons];
    let score = h.score;
    const matched = rules.filter((r) => r.match(h.file));
    for (const { rule } of matched) {
      if (rule.add) {
        score += rule.add;
        reasons.push({ signal: "rule", weight: rule.add, detail: `rule ${rule.paths.join(", ")}` });
      }
    }
    score = Math.max(0, Math.min(100, score));
    let tier: Tier = tierForScore(score, cfg);
    for (const { rule } of matched) {
      if (rule.min_tier && tier < rule.min_tier) {
        tier = rule.min_tier;
        reasons.push({ signal: "rule", weight: 0, detail: `min_tier ${rule.min_tier} (${rule.paths.join(", ")})` });
      }
      if (rule.max_tier && tier > rule.max_tier) {
        tier = rule.max_tier;
        reasons.push({ signal: "rule", weight: 0, detail: `max_tier ${rule.max_tier} (${rule.paths.join(", ")})` });
      }
    }
    return { ...h, score, tier, reasons };
  });
}

/** Tier 0 end to end: score every hunk and route it. `churn` null = no history available. */
export function routeDiff(hunks: Hunk[], cfg: Config, churn: Record<string, Churn> | null = null, rules?: Rules): ScoredHunk[] {
  const compiled = rules ?? compileRules(cfg);
  return routeHunks(scoreHunks(hunks, compiled, cfg.structure.churn.enabled || cfg.structure.hotspot.enabled ? churn : null), cfg);
}
