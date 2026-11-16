// Prices live only in config/prices.json. Cost formula: PLAN.md §0.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { configPath } from "./root";
import type { Usage } from "./types";

const ModelPrice = z.object({
  input: z.number(),
  cache_write_5m: z.number(),
  cache_write_1h: z.number().optional(),
  cache_read: z.number(),
  output: z.number(),
  batch_input: z.number().optional(),
  batch_output: z.number().optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

const PricesFile = z.object({
  as_of: z.string(),
  source: z.string().optional(),
  models: z.record(z.string(), ModelPrice),
});
export type Prices = z.infer<typeof PricesFile>;

export class PricesError extends Error {}

let cached: Prices | undefined;

export function loadPrices(path = configPath("prices.json")): Prices {
  if (path === configPath("prices.json") && cached) return cached;
  const parsed = PricesFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new PricesError(`invalid ${path}: ${parsed.error.message}`);
  if (path === configPath("prices.json")) cached = parsed.data;
  return parsed.data;
}

export function priceFor(model: string, prices: Prices = loadPrices()): ModelPrice {
  const p = prices.models[model];
  if (!p) {
    throw new PricesError(
      `no price for model "${model}" in config/prices.json (known: ${Object.keys(prices.models).join(", ")})`,
    );
  }
  return p;
}

/** USD cost of one response. */
export function costOf(usage: Usage, model: string, prices: Prices = loadPrices()): number {
  const p = priceFor(model, prices);
  const oneHour = Math.min(usage.cache_creation_1h_input_tokens ?? 0, usage.cache_creation_input_tokens);
  return (
    (usage.input_tokens * p.input +
      (usage.cache_creation_input_tokens - oneHour) * p.cache_write_5m +
      oneHour * (p.cache_write_1h ?? p.cache_write_5m) +
      usage.cache_read_input_tokens * p.cache_read +
      usage.output_tokens * p.output) /
    1e6
  );
}

/**
 * Cost of usage spread over several models (claude-code may report more than one). Models missing from
 * config/prices.json fall back to the cost the backend reported, and are listed in `unpriced`.
 */
export function costOfModels(
  byModel: Record<string, { usage: Usage; reportedCostUsd?: number }>,
  prices: Prices = loadPrices(),
): { cost: number; unpriced: string[] } {
  let cost = 0;
  const unpriced: string[] = [];
  for (const [model, u] of Object.entries(byModel)) {
    if (prices.models[model]) cost += costOf(u.usage, model, prices);
    else {
      cost += u.reportedCostUsd ?? 0;
      unpriced.push(model);
    }
  }
  return { cost, unpriced };
}
