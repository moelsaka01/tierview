// GitHub Action entry. Spec: PLAN.md §10. Always the api backend (a runner has no Claude Code login);
// the user's own ANTHROPIC_API_KEY comes in as the `anthropic-api-key` input (a repository secret).
// Review mode: the PR is read through the GitHub API, so no checkout (and no git history) is needed.
import { appendFileSync, readFileSync } from "node:fs";
import { runPr } from "./cli";
import { EXIT, type Review } from "./types";

type Env = Record<string, string | undefined>;

const input = (env: Env, name: string) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();

function setOutput(env: Env, k: string, v: string | number): void {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

export interface ActionIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Returns the process exit code. 0 also covers "skipped" (fork PR without secrets, not a PR event). */
export async function runAction(env: Env, io: ActionIo, run: typeof runPr = runPr): Promise<number> {
  let url: string | undefined;
  try {
    if (env.GITHUB_EVENT_PATH) url = (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { html_url?: string } }).pull_request?.html_url;
  } catch {
    /* handled below */
  }
  if (!url) {
    io.out("::notice::tierview only runs on pull_request events; nothing to review.\n");
    return 0;
  }
  const key = input(env, "anthropic-api-key");
  if (!key) {
    io.out("::notice::tierview skipped: no anthropic-api-key (secrets are not available to pull requests from forks). Nothing was sent anywhere.\n");
    return 0;
  }
  io.out(`::add-mask::${key}\n`);
  process.env.ANTHROPIC_API_KEY = key;
  const token = input(env, "github-token") || env.GITHUB_TOKEN;
  if (token) process.env.GITHUB_TOKEN = token;

  const maxCost = Number.parseFloat(input(env, "max-cost") || "2");
  if (!(maxCost > 0)) {
    io.out("::error::max-cost must be a positive number of USD.\n");
    return EXIT.USAGE;
  }
  const failOn = input(env, "fail-on") || undefined;
  const config = input(env, "config") || undefined;
  let review: Review | undefined;
  const code = await run(
    url,
    { backend: "api", maxCost, failOn, config, comment: true },
    {
      out: () => undefined,
      err: (s) => io.err(s),
      onReview: async (r) => {
        review = r;
      },
    },
  );
  if (review) {
    const cost = review.receipt.total_cost_usd.toFixed(4);
    setOutput(env, "findings", review.findings.length);
    setOutput(env, "cost-usd", cost);
    const line = `tierview: ${review.findings.length} finding(s), cost $${cost} (cap $${maxCost}).\n`;
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line);
    io.out(line);
  }
  if (code === EXIT.BUDGET) {
    io.out(`::warning::tierview stopped at the max-cost cap ($${maxCost}); the review is partial. Raise max-cost to review more.\n`);
    return 0;
  }
  if (code === EXIT.FINDINGS) io.out(`::error::tierview found issues at or above "${failOn}".\n`);
  else if (code !== EXIT.OK) io.out("::error::tierview failed; see the log above.\n");
  return code;
}

if (!process.env.VITEST) {
  runAction(process.env, { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }).then((c) => {
    process.exitCode = c;
  });
}
