// Command definitions. Spec: PLAN.md §3, §5a, §7, §10. `pr` arrives in P5-02.
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ConfigError, type Config, loadConfig } from "./config";
import { estimatePlan, loadEstimates } from "./estimate";
import { FABLE_NOT_ENABLED, FABLE_WARNING, applyFablePolicy, displayName, isFable, usesFable } from "./fable";
import { type FileSource, fileChurn, fileSource, getDiff, isShallow } from "./git";
import { BackendSetupError, type ReviewBackend } from "./llm/backend";
import { ClaudeCodeBackend, defaultCachePath, readModelCache, resolveClaudeBinary, verifyClaudeBinary } from "./llm/claude-code";
import { ApiBackend } from "./llm/client";
import { dryRunJson, reviewJson } from "./output/json";
import { type DryRunView, renderDryRun, renderReview } from "./output/terminal";
import { runPipeline } from "./pipeline";
import { PricesError, loadPrices } from "./prices";
import { parseDiffFiles } from "./tier0/diff";
import { routeDiff } from "./tier0/route";
import { tiersMerged } from "./tiers/collapse";
import { atOrAbove } from "./tiers/escalate";
import { type Backend, EXIT, SEVERITY_ORDER, type Severity } from "./types";

export interface ReviewOptions {
  base?: string;
  head?: string;
  staged?: boolean;
  includeUntracked?: boolean;
  dryRun?: boolean;
  maxCost?: number;
  maxCalls?: number;
  diffFile?: string;
  json?: boolean;
  failOn?: string;
  backend?: string;
  config?: string;
  allowFable?: boolean;
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd?: string;
  /** Test hook: supply the diff instead of running git. */
  diff?: string;
  /** Test hook: supply the backend instead of building one. */
  backend?: ReviewBackend;
  /** Test hook: supply file contents for context. */
  files?: FileSource;
}

function pickBackend(opt: string | undefined, cfg: Config): Backend {
  const b = opt ?? cfg.backend.default;
  if (b !== "api" && b !== "claude-code") throw new ConfigError(`--backend must be "claude-code" or "api", got "${b}"`);
  return b;
}

export async function makeBackend(name: Backend, cfg: Config, allowFable = false): Promise<ReviewBackend> {
  if (name === "api") return new ApiBackend({ concurrency: cfg.backend.api.concurrency });
  const bin = resolveClaudeBinary({ configured: cfg.backend.claude_code.binary });
  if (!bin) {
    throw new BackendSetupError(
      "the claude-code backend needs the official Claude Code CLI. Install it (https://code.claude.com), put `claude` on PATH or set TIERVIEW_CLAUDE_BIN, or use --backend api.",
    );
  }
  await verifyClaudeBinary(bin);
  return new ClaudeCodeBackend({ bin, timeoutMs: cfg.backend.claude_code.timeout_s * 1000, cachePath: defaultCachePath(), allowFable });
}

/** `review`: dry-run or a full run. Returns the exit code. */
export async function runReview(opts: ReviewOptions, io: Io): Promise<number> {
  try {
    if (opts.maxCost !== undefined && !(opts.maxCost > 0)) {
      io.err("tierview: --max-cost must be a positive number of USD.\n");
      return EXIT.USAGE;
    }
    if (opts.maxCalls !== undefined && !(Number.isInteger(opts.maxCalls) && opts.maxCalls > 0)) {
      io.err("tierview: --max-calls must be a positive integer.\n");
      return EXIT.USAGE;
    }
    if (opts.failOn !== undefined && !SEVERITY_ORDER.includes(opts.failOn as Severity)) {
      io.err(`tierview: --fail-on must be one of ${SEVERITY_ORDER.join(", ")}.\n`);
      return EXIT.USAGE;
    }
    const loaded = loadConfig({ cwd: io.cwd, path: opts.config });
    const backendName = io.backend?.name ?? pickBackend(opts.backend, loaded);
    const allowFable = !!opts.allowFable || loaded.allowFable;
    const { cfg, substitutions } = applyFablePolicy(loaded, backendName, allowFable);
    const diffOpts = { base: opts.base, head: opts.head, staged: opts.staged, includeUntracked: opts.includeUntracked, cwd: io.cwd };
    const supplied = io.diff ?? (opts.diffFile !== undefined ? readFileSync(opts.diffFile, "utf8") : undefined);
    const diffText = supplied ?? getDiff(diffOpts);
    const files = parseDiffFiles(diffText);
    const hunks = files.flatMap((f) => f.hunks);
    if (files.length === 0) {
      io.out("No changes to review.\n");
      return EXIT.OK;
    }

    const warnings: string[] = [];
    let churn = null;
    if (cfg.structure.churn.enabled || cfg.structure.hotspot.enabled) {
      if (supplied === undefined && !isShallow(io.cwd)) {
        churn = fileChurn([...new Set(hunks.map((h) => h.file))], Math.max(cfg.structure.churn.days, cfg.structure.hotspot.days), cfg.structure.hotspot.pattern, io.cwd);
      } else {
        warnings.push("git history unavailable (shallow clone or no checkout): churn and hotspot signals contributed 0.");
      }
    }
    const noHunks = files.filter((f) => f.hunks.length === 0);
    if (noHunks.length) warnings.push(`${noHunks.length} file(s) have no reviewable hunks (binary or pure rename): ${noHunks.map((f) => f.path).join(", ")}.`);

    const routed = routeDiff(hunks, cfg, churn);
    const est = loadEstimates();
    const prices = loadPrices();
    if (!est.calibrated) warnings.push("token and output estimates are uncalibrated placeholders (config/estimates.json); treat costs as rough.");
    const maxCost = opts.maxCost ?? cfg.budget.max_cost_usd;
    const plannedSubs = substitutions.filter((s) => routed.some((h) => h.tier === s.tier));

    if (opts.dryRun) {
      const plan = estimatePlan(routed, cfg, prices, est, backendName);
      const subNotes = plannedSubs.map((s) => `Tier ${s.tier} will run on ${displayName(s.used)} (${FABLE_NOT_ENABLED}; --allow-fable to use ${displayName(s.requested)}).`);
      if (tiersMerged(cfg) && routed.some((h) => h.tier === 2)) subNotes.push(`Tier 2 and Tier 3 both run ${displayName(cfg.models.tier3.model)}: Tier 2 hunks join the Tier 3 call (one call at the higher effort).`);
      const view: DryRunView = { routed, plan, warnings: [...subNotes, ...warnings, `prices as of ${prices.as_of}.`], maxCost };
      io.out(opts.json ? dryRunJson({ ...view, pricesAsOf: prices.as_of }) : renderDryRun(view));
      return EXIT.OK;
    }

    const backend = io.backend ?? (await makeBackend(backendName, cfg, allowFable));
    // Opt-in Fable (PLAN §5a): warn before the first call.
    if (backendName === "claude-code" && allowFable && usesFable(cfg)) io.err(FABLE_WARNING);
    if (supplied !== undefined && !io.files) warnings.push("diff supplied without a checkout: Tier 2 and 3 saw no surrounding file context.");
    const fileSrc = io.files ?? (supplied === undefined ? fileSource(diffOpts) : () => null);
    const { review, budgetExhausted } = await runPipeline({ routed, cfg, backend, files: fileSrc, prices, est, maxCost, maxCalls: opts.maxCalls ?? null, substitutions, warnings });
    io.out(opts.json ? reviewJson(review) : renderReview(review));
    if (opts.failOn && review.findings.some((f) => atOrAbove(f.severity, opts.failOn as Severity))) return EXIT.FINDINGS;
    if (budgetExhausted) return EXIT.BUDGET;
    return EXIT.OK;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof PricesError || e instanceof BackendSetupError) {
      io.err(`tierview: ${e.message}\n`);
      return EXIT.USAGE;
    }
    const msg = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
    io.err(`tierview: ${msg}\n`);
    return EXIT.USAGE;
  }
}

/** `models`: which tier models Claude Code actually runs on this plan (cached, or probed with --probe). */
export async function runModels(opts: { probe?: boolean; config?: string; allowFable?: boolean }, io: Io): Promise<number> {
  try {
    const cfg = loadConfig({ cwd: io.cwd, path: opts.config });
    const allowFable = !!opts.allowFable || cfg.allowFable;
    const models = [...new Set([cfg.models.tier1.model, cfg.models.tier2.model, cfg.models.tier3.model])];
    const cachePath = defaultCachePath();
    if (opts.probe) {
      const bin = resolveClaudeBinary({ configured: cfg.backend.claude_code.binary });
      if (!bin) throw new BackendSetupError("Claude Code CLI not found (see `tierview review --help`).");
      const probed = models.filter((m) => allowFable || !isFable(m));
      io.err(`${await verifyClaudeBinary(bin)}: probing ${probed.length} model(s), one tiny call each.\n`);
      if (allowFable && probed.some(isFable)) io.err(FABLE_WARNING);
      const cc = new ClaudeCodeBackend({ bin, cachePath, allowFable });
      for (const r of await cc.probe(models)) {
        io.out(`${r.model}: ${r.used === r.model ? "available" : r.used ? `ran ${r.used} instead` : `unavailable (${r.error ?? "no usage reported"})`}\n`);
      }
      return EXIT.OK;
    }
    const cache = readModelCache(cachePath);
    for (const m of models) {
      if (!allowFable && isFable(m)) {
        io.out(`${m}: ${FABLE_NOT_ENABLED} (pass --allow-fable or set allowFable: true; Tier 3 runs on ${displayName(cfg.models.tier2.model)})\n`);
        continue;
      }
      const c = cache[m];
      io.out(`${m}: ${c ? `${c.used === m ? "available" : `runs as ${c.used}`} (checked ${c.checked.slice(0, 10)}: ${c.reason})` : "not checked yet (run `tierview models --probe`, or a review will detect it)"}\n`);
    }
    return EXIT.OK;
  } catch (e) {
    io.err(`tierview: ${(e as Error).message}\n`);
    return EXIT.USAGE;
  }
}

function notImplemented(what: string, phase: number): never {
  process.stderr.write(`tierview: ${what} is not implemented yet (Phase ${phase}, see PLAN.md).\n`);
  process.exit(EXIT.USAGE);
}

const stdio: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option("--dry-run", "show routing and estimated cost; make zero model calls")
    .option("--backend <name>", "claude-code (the official claude CLI, default) or api (ANTHROPIC_API_KEY)")
    .option("--max-cost <usd>", "hard budget cap for this run, in USD (API-equivalent on claude-code)", Number.parseFloat)
    .option("--max-calls <n>", "hard cap on model calls for this run (useful within plan limits)", (v) => Number(v))
    .option("--json", "print the review as JSON")
    .option("--sarif <file>", "write SARIF 2.1.0 to a file")
    .option("--fail-on <severity>", "exit 1 if a finding is at or above this severity")
    .option("--config <file>", "path to a config file (default: .tierview.yml in the current directory)")
    .option("--allow-fable", "claude-code backend: allow Fable 5.2 (may use paid extra usage on some plans)");
}

export function buildProgram(): Command {
  const program = new Command()
    .name("tierview")
    .description("AI code review that escalates through Claude model tiers and prints a cost receipt.")
    .version("0.0.1");

  addSharedOptions(
    program
      .command("review")
      .description("review a local git diff")
      .option("--base <ref>", "base ref", "HEAD")
      .option("--head <ref>", "head ref (default: the working tree)")
      .option("--staged", "review staged changes only")
      .option("--include-untracked", "also review new files git does not track yet (working tree only)")
      .option("--diff-file <path>", "review a saved unified diff instead of running git (no file context)"),
  ).action(async (opts: ReviewOptions) => {
    process.exitCode = await runReview(opts, stdio);
  });

  program
    .command("models")
    .description("show which tier models Claude Code runs on your plan")
    .option("--probe", "check now with one tiny claude call per model")
    .option("--config <file>", "path to a config file")
    .option("--allow-fable", "also probe Fable 5.2 (may use paid extra usage on some plans)")
    .action(async (opts: { probe?: boolean; config?: string; allowFable?: boolean }) => {
      process.exitCode = await runModels(opts, stdio);
    });

  addSharedOptions(
    program
      .command("pr")
      .description("review a GitHub pull request")
      .argument("<url>", "pull request URL")
      .option("--comment", "post the review as a PR comment"),
  ).action(() => notImplemented("pr", 5));

  return program;
}
