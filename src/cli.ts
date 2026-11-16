// Command definitions. Spec: PLAN.md §3, §7, §10. `review --dry-run` is live; LLM tiers arrive in P3-09, `pr` in P5-02.
import { Command } from "commander";
import { ConfigError, loadConfig } from "./config";
import { estimatePlan, loadEstimates } from "./estimate";
import { fileChurn, getDiff, isShallow } from "./git";
import { dryRunJson } from "./output/json";
import { type DryRunView, renderDryRun } from "./output/terminal";
import { PricesError, loadPrices } from "./prices";
import { parseDiffFiles } from "./tier0/diff";
import { routeDiff } from "./tier0/route";
import { EXIT } from "./types";

export interface ReviewOptions {
  base?: string;
  head?: string;
  staged?: boolean;
  dryRun?: boolean;
  maxCost?: number;
  json?: boolean;
  config?: string;
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd?: string;
  /** Test hook: supply the diff instead of running git. */
  diff?: string;
}

/** Everything `review --dry-run` prints, as a pure function of a diff. Returns the exit code. */
export function runReview(opts: ReviewOptions, io: Io): number {
  try {
    if (!opts.dryRun) {
      io.err("tierview: LLM tiers arrive in Phase 3. Use --dry-run to see routing and the estimated cost.\n");
      return EXIT.USAGE;
    }
    if (opts.maxCost !== undefined && !(opts.maxCost > 0)) {
      io.err("tierview: --max-cost must be a positive number of USD.\n");
      return EXIT.USAGE;
    }
    const cfg = loadConfig({ cwd: io.cwd, path: opts.config });
    const diffText = io.diff ?? getDiff({ base: opts.base, head: opts.head, staged: opts.staged, cwd: io.cwd });
    const files = parseDiffFiles(diffText);
    const hunks = files.flatMap((f) => f.hunks);
    if (files.length === 0) {
      io.out("No changes to review.\n");
      return EXIT.OK;
    }

    const warnings: string[] = [];
    let churn = null;
    if (cfg.structure.churn.enabled || cfg.structure.hotspot.enabled) {
      if (io.diff === undefined && !isShallow(io.cwd)) {
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
    const plan = estimatePlan(routed, cfg, prices, est);
    if (!est.calibrated) warnings.push("token and output estimates are uncalibrated placeholders (config/estimates.json); treat costs as rough.");
    warnings.push(`prices as of ${prices.as_of}.`);

    const view: DryRunView = { routed, plan, warnings, maxCost: opts.maxCost ?? cfg.budget.max_cost_usd };
    io.out(opts.json ? dryRunJson({ ...view, pricesAsOf: prices.as_of }) : renderDryRun(view));
    return EXIT.OK;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof PricesError) {
      io.err(`tierview: ${e.message}\n`);
      return EXIT.USAGE;
    }
    const msg = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
    io.err(`tierview: ${msg}\n`);
    return EXIT.USAGE;
  }
}

function notImplemented(what: string, phase: number): never {
  process.stderr.write(`tierview: ${what} is not implemented yet (Phase ${phase}, see PLAN.md).\n`);
  process.exit(EXIT.USAGE);
}

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option("--dry-run", "show routing and estimated cost; make zero API calls")
    .option("--max-cost <usd>", "hard budget cap for this run, in USD", Number.parseFloat)
    .option("--json", "print the review as JSON")
    .option("--sarif <file>", "write SARIF 2.1.0 to a file")
    .option("--fail-on <severity>", "exit 1 if a finding is at or above this severity")
    .option("--config <file>", "path to a config file (default: .tierview.yml in the current directory)");
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
      .option("--staged", "review staged changes only"),
  ).action((opts: ReviewOptions) => {
    process.exitCode = runReview(opts, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
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
