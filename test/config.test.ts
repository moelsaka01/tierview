import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { PricesError, costOf, loadPrices } from "../src/prices";

function withYml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tierview-cfg-"));
  writeFileSync(join(dir, ".tierview.yml"), body);
  return dir;
}

describe("loadConfig", () => {
  it("loads the defaults when there is no .tierview.yml", () => {
    const cfg = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "tierview-empty-")) });
    expect(cfg.thresholds).toEqual({ tier2: 30, tier3: 60 });
    expect(cfg.categories.auth?.weight).toBe(35);
    expect(cfg.structure.size.at(-1)?.[0]).toBe(Infinity);
  });

  it("merges the user file over the defaults", () => {
    const cwd = withYml(`
version: 1
thresholds: { tier2: 25 }
ignore: ["docs/**"]
rules:
  - { paths: ["src/billing/**"], min_tier: 3 }
signals: { churn: { enabled: false }, auth: { weight: 45 } }
`);
    const cfg = loadConfig({ cwd });
    expect(cfg.thresholds).toEqual({ tier2: 25, tier3: 60 });
    expect(cfg.ignore).toEqual(["docs/**"]);
    expect(cfg.rules[0]).toMatchObject({ min_tier: 3 });
    expect(cfg.structure.churn.enabled).toBe(false);
    expect(cfg.structure.churn.days).toBe(90);
    expect(cfg.categories.auth?.weight).toBe(45);
    expect(cfg.categories.auth?.path.length).toBeGreaterThan(0);
  });

  it("rejects bad input with a clear message", () => {
    expect(() => loadConfig({ cwd: withYml("thresholds: { tier2: 70 }") })).toThrow(/tier2 must be below/);
    expect(() => loadConfig({ cwd: withYml("signals: { nope: { weight: 1 } }") })).toThrow(/unknown signal "nope"/);
    expect(() => loadConfig({ cwd: withYml("rules: [{ paths: ['a'], min_tier: 3, max_tier: 1 }]") })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd: withYml("signals: { auth: { content: ['('] } }") })).toThrow(/invalid regex/);
    expect(() => loadConfig({ path: "nope.yml" })).toThrow(/not found/);
  });
});

describe("prices", () => {
  const usage = { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000 };

  it("applies the §0 formula", () => {
    expect(costOf(usage, "claude-sonnet-5-5")).toBeCloseTo(2 + 2.5 + 0.1 + 10);
    expect(costOf(usage, "claude-fable-5-2")).toBeCloseTo(8 + 10 + 0.2 + 40);
    expect(costOf({ ...usage, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 }, "claude-opus-5-5")).toBeCloseTo(0.01);
  });

  it("names the unknown model", () => {
    expect(() => costOf(usage, "claude-nope")).toThrow(PricesError);
    expect(() => costOf(usage, "claude-nope")).toThrow(/claude-nope.*known: /);
  });

  it("has an as_of date", () => {
    expect(loadPrices().as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
