// Command definitions. Spec: PLAN.md §3, §7, §10. Behaviour arrives in P2-07, P3-09 and P5-02.
import { Command } from "commander";
import { EXIT } from "./types";

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
    .option("--config <file>", "path to .tierview.yml", ".tierview.yml");
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
  ).action(() => notImplemented("review", 2));

  addSharedOptions(
    program
      .command("pr")
      .description("review a GitHub pull request")
      .argument("<url>", "pull request URL")
      .option("--comment", "post the review as a PR comment"),
  ).action(() => notImplemented("pr", 5));

  return program;
}
