// P4-04: the benchmark arms as config presets over the real pipeline. Spec: PLAN.md §9.
// No Fable arm and no Fable calls: the tierview arm runs without --allow-fable, so Tier 3 is Opus 5.5 (high).
// Model IDs come from the loaded config (Tier 1 = Sonnet 5.5, Tier 2 = Opus 5.5), never from this file.
import type { Config } from "../src/config";
import { applyFablePolicy } from "../src/fable";
import type { ModelSubstitution } from "../src/types";

export const ARMS = ["tierview", "all-sonnet", "all-opus"] as const;
export type Arm = (typeof ARMS)[number];

/**
 * Bumped when an arm's behaviour changes; saved runs of an older version are stale and re-run.
 * tierview v2 (2026-11-16): Tier 2 and Tier 3 merged into one Opus call, whole-diff escalation (PLAN §6).
 */
export const ARM_VERSION: Record<Arm, number> = { tierview: 2, "all-sonnet": 1, "all-opus": 1 };

export interface ArmPreset {
  arm: Arm;
  cfg: Config;
  /** Substitutions decided before the run (Fable not enabled), passed to the pipeline for the receipt. */
  substitutions: ModelSubstitution[];
}

/**
 * tierview: the frozen config as is. Baselines: every non-generated hunk goes to Tier 3 (a `min_tier: 3` rule over
 * all paths) with the Tier 3 request shape and context, on one model and effort; Tier 3 never escalates.
 */
export function armPreset(arm: Arm, base: Config): ArmPreset {
  if (arm === "tierview") {
    const { cfg, substitutions } = applyFablePolicy(base, "claude-code", false);
    return { arm, cfg, substitutions };
  }
  const model = arm === "all-sonnet" ? { model: base.models.tier1.model, effort: "low" as const } : { model: base.models.tier2.model, effort: "medium" as const };
  const cfg: Config = {
    ...base,
    allowFable: false,
    models: { tier1: model, tier2: model, tier3: model },
    rules: [...base.rules, { paths: ["**"], min_tier: 3 }],
  };
  return { arm, cfg, substitutions: [] };
}

export function parseArms(list: string | undefined): Arm[] {
  if (!list) return [...ARMS];
  const arms = list.split(",").map((s) => s.trim());
  for (const a of arms) if (!(ARMS as readonly string[]).includes(a)) throw new Error(`unknown arm "${a}" (known: ${ARMS.join(", ")})`);
  return arms as Arm[];
}
