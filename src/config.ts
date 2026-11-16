// Loads config/default-rules.yml and merges .tierview.yml over it. Spec: PLAN.md §4.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { configPath } from "./root";

export class ConfigError extends Error {}

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const TierModel = z.object({ model: z.string().min(1), effort: Effort });
const TierNum = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const Category = z
  .object({
    weight: z.number(),
    path: z.array(z.string()).default([]),
    content: z.array(z.string()).default([]),
    content_added: z.array(z.string()).default([]),
    content_removed: z.array(z.string()).default([]),
    logic: z.array(z.string()).default([]),
  })
  .strict();

const Rule = z
  .object({
    paths: z.array(z.string()).min(1),
    min_tier: TierNum.optional(),
    max_tier: TierNum.optional(),
    add: z.number().optional(),
  })
  .strict()
  .refine((r) => !r.min_tier || !r.max_tier || r.min_tier <= r.max_tier, "min_tier must be <= max_tier");

const Structure = z.object({
  size: z.array(z.tuple([z.union([z.number(), z.literal(Infinity)]), z.number()])).min(1),
  scatter: z.object({ max_files: z.number(), max_top_dirs: z.number(), points: z.number() }),
  many_hunks_in_file: z.object({ more_than: z.number(), points: z.number() }),
  churn: z.object({ enabled: z.boolean(), days: z.number(), min_commits: z.number(), points: z.number() }),
  hotspot: z.object({
    enabled: z.boolean(),
    days: z.number(),
    min_fix_commits: z.number(),
    points: z.number(),
    pattern: z.string(),
  }),
  deletion_only: z.object({ points: z.number() }),
  diff_weakens_tests: z.object({ points: z.number() }),
  no_tests_changed: z.object({ min_source_lines: z.number(), points: z.number() }),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  models: z.object({ tier1: TierModel, tier2: TierModel, tier3: TierModel }),
  thresholds: z.object({ tier2: z.number(), tier3: z.number() }),
  escalation: z.object({
    tier1_min_confidence: z.number().min(0).max(1),
    tier2_min_confidence: z.number().min(0).max(1),
    tier1_verify_severity: z.string(),
    tier2_verify_severity: z.string(),
    max_rate: z.number().min(0).max(1),
  }),
  budget: z.object({ max_cost_usd: z.number().positive().nullable() }),
  receipt: z.object({ baseline: TierModel }),
  backend: z.object({
    default: z.enum(["claude-code", "api"]),
    claude_code: z.object({
      binary: z.string().nullable(),
      max_hunks_per_call: z.number().int().positive(),
      max_tokens_per_call: z.number().int().positive(),
      timeout_s: z.number().positive(),
    }),
    api: z.object({ max_tokens: z.number().int().positive(), concurrency: z.number().int().positive() }),
  }),
  ignore: z.array(z.string()),
  rules: z.array(Rule),
  file_kinds: z.object({
    generated: z.array(z.string()),
    docs: z.array(z.string()),
    test: z.array(z.string()),
    config: z.array(z.string()),
  }),
  categories: z.record(z.string(), Category),
  structure: Structure,
  reductions: z.object({ test_file_without_test_signal: z.number(), docs_or_trivial_cap: z.number() }),
});
export type Config = z.infer<typeof ConfigSchema>;
export type CategoryRule = z.infer<typeof Category>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars from `over` replace. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

/** `signals:` overrides a category (e.g. auth.weight) or a structure signal (e.g. churn.enabled). */
function applySignals(cfg: Obj, signals: unknown): void {
  if (signals === undefined || signals === null) return;
  if (!isObj(signals)) throw new ConfigError("`signals` must be a mapping");
  const cats = cfg.categories as Obj;
  const structure = cfg.structure as Obj;
  for (const [name, value] of Object.entries(signals)) {
    if (name in cats) cats[name] = deepMerge(cats[name], value);
    else if (name in structure) structure[name] = deepMerge(structure[name], value);
    else {
      const known = [...Object.keys(cats), ...Object.keys(structure)].join(", ");
      throw new ConfigError(`unknown signal "${name}" in .tierview.yml (known: ${known})`);
    }
  }
}

function checkRegexes(cfg: Config): void {
  const check = (where: string, src: string) => {
    try {
      new RegExp(src, "i");
    } catch (e) {
      throw new ConfigError(`invalid regex in ${where}: ${src} (${(e as Error).message})`);
    }
  };
  for (const [name, c] of Object.entries(cfg.categories)) {
    for (const key of ["path", "content", "content_added", "content_removed"] as const) {
      for (const p of c[key]) check(`categories.${name}.${key}`, p);
    }
  }
  check("structure.hotspot.pattern", cfg.structure.hotspot.pattern);
}

export interface LoadOptions {
  /** Directory searched for .tierview.yml when `path` is not given. Default: cwd. */
  cwd?: string;
  /** Explicit config file. A missing explicit file is an error; a missing default file is not. */
  path?: string;
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const defaults = parse(readFileSync(configPath("default-rules.yml"), "utf8")) as Obj;
  const file = opts.path ?? join(opts.cwd ?? process.cwd(), ".tierview.yml");
  let merged: Obj = defaults;
  if (existsSync(file)) {
    let user: unknown;
    try {
      user = parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new ConfigError(`cannot parse ${file}: ${(e as Error).message}`);
    }
    if (user !== null && user !== undefined) {
      if (!isObj(user)) throw new ConfigError(`${file} must be a mapping`);
      const { signals, ...rest } = user;
      merged = deepMerge(defaults, rest) as Obj;
      applySignals(merged, signals);
    }
  } else if (opts.path) {
    throw new ConfigError(`config file not found: ${file}`);
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid config: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.thresholds.tier2 >= cfg.thresholds.tier3) throw new ConfigError("thresholds.tier2 must be below thresholds.tier3");
  checkRegexes(cfg);
  return cfg;
}
