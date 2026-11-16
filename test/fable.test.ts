// Fable opt-in on the claude-code backend (PLAN §5a).
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { FABLE_NOT_ENABLED, applyFablePolicy, displayName, substitutionLine, usesFable } from "../src/fable";
import { cfg } from "./helpers";

const T2 = cfg.models.tier2.model;
const T3 = cfg.models.tier3.model;

describe("Fable policy", () => {
  it("names models for the receipt", () => {
    expect(displayName(T2)).toBe("Opus 5.5");
    expect(displayName(T3)).toBe("Fable 5.2");
    expect(displayName("my-model")).toBe("my-model");
  });

  it("defaults to off and replaces Fable tiers with the Tier 2 model at the tier's own effort", () => {
    expect(cfg.allowFable).toBe(false);
    const p = applyFablePolicy(cfg, "claude-code", false);
    expect(p.cfg.models.tier3).toEqual({ model: T2, effort: cfg.models.tier3.effort });
    expect(p.cfg.receipt.baseline.model).toBe(T3);
    expect(usesFable(p.cfg)).toBe(false);
    expect(p.substitutions).toEqual([{ tier: 3, requested: T3, used: T2, reason: FABLE_NOT_ENABLED }]);
    expect(substitutionLine(p.substitutions[0]!)).toBe("Tier 3 ran on Opus 5.5 (Fable not enabled)");
  });

  it("leaves the config alone with opt-in or on the api backend", () => {
    expect(applyFablePolicy(cfg, "claude-code", true).cfg).toBe(cfg);
    expect(applyFablePolicy(cfg, "api", false).cfg).toBe(cfg);
  });

  it("errors when every tier is Fable and Fable is off", () => {
    const allFable = { ...cfg, models: { tier1: cfg.models.tier3, tier2: cfg.models.tier3, tier3: cfg.models.tier3 } };
    expect(() => applyFablePolicy(allFable, "claude-code", false)).toThrow(ConfigError);
  });
});
