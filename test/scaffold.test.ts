// Checks that the scaffold is coherent. Later phases add real tests next to this file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildProgram } from "../src/cli";
import { TierResponse } from "../src/types";

const prices = JSON.parse(readFileSync("config/prices.json", "utf8"));
const rules = parse(readFileSync("config/default-rules.yml", "utf8"));

describe("scaffold", () => {
  it("exposes the review and pr commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(["review", "pr"]);
  });

  it("has a price for every configured tier model", () => {
    for (const tier of ["tier1", "tier2", "tier3"]) {
      const model = rules.models[tier].model;
      expect(prices.models[model], model).toBeDefined();
      expect(prices.models[model].output).toBeGreaterThan(prices.models[model].input);
    }
  });

  it("has rules whose regexes all compile", () => {
    for (const [name, cat] of Object.entries<Record<string, unknown>>(rules.categories)) {
      expect(typeof cat.weight, name).toBe("number");
      for (const key of ["path", "content", "content_added", "content_removed"]) {
        for (const pattern of (cat[key] as string[] | undefined) ?? []) {
          expect(() => new RegExp(pattern, "i"), `${name}.${key}: ${pattern}`).not.toThrow();
        }
      }
    }
    expect(rules.thresholds.tier2).toBeLessThan(rules.thresholds.tier3);
  });

  it("parses a minimal tier response", () => {
    const parsed = TierResponse.parse({
      reviews: [
        {
          hunk_id: "src/a.ts#1",
          verdict: "clean",
          confidence: 0.9,
          needs_escalation: false,
          escalation_reason: "",
          refuted_prior: [],
          findings: [],
        },
      ],
    });
    expect(parsed.reviews).toHaveLength(1);
  });
});
