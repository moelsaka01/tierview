// Fable 5.2 is opt-in on the claude-code backend. Spec: PLAN.md §5a ("Fable is opt-in").
// On some plans Fable draws on paid extra usage, and `claude -p` bills it without asking, so tierview never
// requests Fable through Claude Code unless the user passes --allow-fable or sets `allowFable: true`.
import { type Config, ConfigError } from "./config";
import type { Backend, LlmTier, ModelSubstitution } from "./types";

export const FABLE_NOT_ENABLED = "Fable not enabled";

export const FABLE_WARNING =
  "tierview: Fable is enabled (--allow-fable / allowFable). On some Claude plans Fable may use paid extra usage, and `claude -p` does not ask before using it.\n";

export const isFable = (model: string) => /fable/i.test(model);

/** "claude-opus-5-5" -> "Opus 5.5". Falls back to the id for names that do not follow that shape. */
export function displayName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!m) return id;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}`;
}

export interface FablePolicy {
  cfg: Config;
  /** One per tier whose Fable model was replaced; the pipeline reports those that made calls. */
  substitutions: ModelSubstitution[];
}

/**
 * Without opt-in on claude-code, every tier set to a Fable model runs on the Tier 2 model instead (Opus 5.5 by
 * default), at that tier's own effort. No Fable-first request is made. The receipt baseline (`receipt.baseline`)
 * is untouched: the all-Fable comparison is only a calculation.
 */
export function applyFablePolicy(cfg: Config, backend: Backend, allowFable: boolean): FablePolicy {
  if (backend !== "claude-code" || allowFable) return { cfg, substitutions: [] };
  const tiers: LlmTier[] = [1, 2, 3];
  const fableTiers = tiers.filter((t) => isFable(cfg.models[`tier${t}`].model));
  if (!fableTiers.length) return { cfg, substitutions: [] };
  const substitute = [cfg.models.tier2.model, cfg.models.tier1.model].find((m) => !isFable(m));
  if (!substitute) throw new ConfigError("every tier model is Fable, but Fable is not enabled. Pass --allow-fable, set allowFable: true, or choose another model.");
  const models = { ...cfg.models };
  const substitutions: ModelSubstitution[] = [];
  for (const t of fableTiers) {
    const k = `tier${t}` as const;
    substitutions.push({ tier: t, requested: models[k].model, used: substitute, reason: FABLE_NOT_ENABLED });
    models[k] = { ...models[k], model: substitute };
  }
  return { cfg: { ...cfg, models }, substitutions };
}

/** True when a run with this config would send Fable requests through Claude Code. */
export const usesFable = (cfg: Config) => [cfg.models.tier1, cfg.models.tier2, cfg.models.tier3].some((m) => isFable(m.model));

/** The receipt line for one substitution. */
export function substitutionLine(s: ModelSubstitution): string {
  if (s.reason === FABLE_NOT_ENABLED) return `Tier ${s.tier} ran on ${displayName(s.used)} (${FABLE_NOT_ENABLED})`;
  return `Tier ${s.tier} ran on ${displayName(s.used)} instead of ${displayName(s.requested)} (${s.reason})`;
}
