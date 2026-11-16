# Build log

One entry per phase: which model did the work, at what effort, from what prompt, and what went wrong or changed. Each phase runs in a fresh chat; the plan is [PLAN.md](PLAN.md).

| Phase | Scope | Model (effort) | Status |
|---|---|---|---|
| 1 | Plan and scaffold | Fable 5.2 (high) | done 2026-11-16 |
| 2 | Tier 0, config, dry-run | Sonnet 5.5 (medium) | done 2026-11-16 |
| 3 | LLM tiers, escalation, receipt, backends | Opus 5.5 (high) | done 2026-11-16 |
| 4 | Benchmark | Opus 5.5 (high) | in progress: dataset and harness done, no model calls yet |
| 5 | PR mode, SARIF, GitHub Action | Sonnet 5.5 | not started |
| 6 | README and release | Sonnet 5.5 | not started |

---

## Phase 1 — plan and scaffold (2026-11-16)

**Model.** The chat started on Sonnet 5.5 (`claude-sonnet-5-5`) by mistake. Sonnet did the lookups: two web searches and two page reads for the competitor check, and the pricing page. The session was then switched to Fable 5.2 (`claude-fable-5-2`), which wrote `PLAN.md`, the scaffold and this log.

**Effort.** High (recorded by Mohamed in Phase 3; the app does not show the effort level to the model).

**Tooling.** Claude Code desktop app, Windows 11, Node 24.14, npm 11.9.

**Prompt.** One message, sent twice (before and after the model switch).

<details>
<summary>Phase 1 prompt, verbatim</summary>

We're building **tierview**: an open-source CLI + GitHub Action for AI code review that escalates through Claude model tiers so you get top-model review quality on the risky parts at a fraction of the cost. Tagline: "Fable-level code review at Sonnet prices."

**Context**
- I'm Mohamed Elsaka (GitHub: moelsaka01). My other repos (honest-ml, honest-tests, honest-done) set the README style.
- Goals: GitHub stars, recruiter appeal (model routing, cost engineering, evaluation), and later a paid hosted GitHub App. Stay open source with bring-your-own Anthropic API key.
- Build plan: I'll run each phase in a new chat with a different model (Phase 1 Fable 5.2, Phase 2 Sonnet 5.5, Phase 3 Opus 5.5, Phase 4 Opus 5.5, Phase 5 Sonnet 5.5, Phase 6 Sonnet 5.5). I'm on a Claude Pro plan with limited usage, so be efficient: plan precisely, keep PLAN.md self-sufficient, and avoid re-reading large files.

**How it works**
1. **Tier 0 (no LLM):** parse the diff (local git or a GitHub PR), split it into hunks, and give each hunk a risk score from deterministic signals: sensitive paths/keywords (auth, crypto, payment, SQL, migrations, permissions, secrets, concurrency, deserialization), deleted or skipped tests, hunk count and how scattered the change is, file churn history, size. Configurable rules in `.tierview.yml`.
2. **Tier 1 — Sonnet 5.5, low effort:** reviews low-risk hunks, batched with shared context. It must return structured JSON: findings + a confidence score.
3. **Tier 2 — Opus 5.5, medium effort:** reviews medium-risk hunks, plus any Tier 1 result with low confidence or contradictory findings.
4. **Tier 3 — Fable 5.2, high effort:** reviews only critical hunks (and whatever Opus escalates), with surrounding file context.
5. **Merge:** one deduplicated review ranked by severity, with each finding labelled by the model that made it.
6. **Cost receipt:** per-tier hunk counts, tokens, actual cost, and the estimated cost if everything had gone to Fable 5.2. Use prompt caching for shared context.
- Use the official Anthropic SDK. Look up the **current** model IDs, pricing and effort/thinking parameters in the official docs (don't guess; check the Fable 5.2 ID and price specifically). Put prices in one config file.
- Modes: `tierview review` (local diff), `tierview pr <url>`, `--dry-run` (shows routing and estimated cost with zero API calls), `--max-cost` (hard budget cap), `--json` and SARIF output.

**Benchmark (the credibility of the project depends on this)**
Build a dataset of 50–100 real bug-introducing changes from open-source repos where the bug was later fixed (so we have ground truth), plus clean changes for false-positive rates. Compare tierview with all-Sonnet, all-Opus and all-Fable on: bugs caught, false positives, cost, latency. Output a results table and a chart for the README. **Hard cap the total benchmark API spend at $25** (configurable). Run on a 10-case subset first, report the measured cost and a projection, and ask me before running the full set.

**Phase 1 (this chat only)**
1. Quick competitor check (CodeRabbit, Qodo/pr-agent, others): confirm none offer open-source tiered escalation with a cost receipt, and summarize in 5 lines how we differ.
2. Write `PLAN.md`: architecture, language choice (recommend TypeScript or Python, with a reason), module layout, the risk-scoring rules, routing thresholds, the escalation/confidence logic, the JSON schemas for findings, the benchmark design (data sources, ground-truth method, metrics), and a phased task list matching the model plan above. Each task is small, checkable, and names its files.
3. Scaffold the repo skeleton + `BUILD_LOG.md` (record model, effort, prompts and issues per phase), git init, commit, and stop.

</details>

**Delivered.** `PLAN.md`; `config/prices.json` (prices checked against the official pricing page on 2026-11-16); `config/default-rules.yml` (the risk rules as data); `config/estimates.json`; `src/types.ts` (schemas); CLI skeleton (`src/cli.ts`, `src/bin.ts`); one stub per planned module; `test/scaffold.test.ts`. `npm run check` passes (typecheck, 4 tests) and `npm run build` produces a CLI that prints help.

**Issues and decisions.**

1. **Wrong model at the start.** The first part of the chat ran on Sonnet 5.5 instead of Fable 5.2. Only lookups were done on it; nothing it wrote is in the repo.
2. **The premise "nobody does tiered routing" is false.** d1ff (MIT) and OrcaCode Review already route between cheap and strong models, and Qodo has a per-PR depth router. What the check did not find is per-hunk routing with confidence escalation, a counterfactual cost receipt, or a published ground-truth benchmark. The plan positions tierview on the receipt and the benchmark (PLAN §1). The check was two searches and two page reads, not a code audit.
3. **Forced tool choice is rejected by all three models**, so "must return structured JSON" is done with structured outputs (`messages.parse` + `zodOutputFormat`), not a forced tool call (PLAN §0).
4. **The benchmark probably does not fit in $25 if run synchronously.** By a rough estimate, all-Fable alone is about $0.20 per case. The plan runs the baselines through the Batch API (50% off) and takes baseline latency from the synchronous 10-case pilot. The pilot replaces the estimate with measurements before anything large runs (PLAN §9).
5. **Added a fifth benchmark arm, `all-fable-low`.** Anthropic's own cost guidance says to compare a cascade against the top model at low effort. If that arm wins, the project should say so (PLAN §12).
6. **The tagline is gated on the benchmark** (PLAN §12).
7. **Placeholders that later phases must replace:** `config/estimates.json` (calibrate in P3-10); risk weights and thresholds (tune in Phase 4 on the dev split only).
8. **Not verified:** whether `zodOutputFormat` in SDK 1.8 accepts zod 4 schemas as written in `src/types.ts` (first exercised in P3-01); the GitHub Actions runtime name `node24` in `action.yml` (check in P5-05); the three candidate datasets named in PLAN §9.
9. **Installed versions are newer majors than a model may expect** (`@anthropic-ai/sdk` 1.8, zod 4.6, TypeScript 7.0, vitest 5.1, commander 15, tsup 9). Check the installed package's types before assuming an older API.

**API spend this phase:** $0 (no Anthropic API calls from the project).

---

## Phase 2 — Tier 0, config, dry-run (2026-11-16)

**Model.** Sonnet 5.5 (`claude-sonnet-5-5`), as planned.

**Effort.** Medium (recorded by Mohamed in Phase 3).

**Prompt.** "Read PLAN.md and BUILD_LOG.md. Do Phase 2 only. Update BUILD_LOG.md (including model and effort) and commit when done." The chat was opened in a scratch folder, so the session was moved to the tierview folder first. Two recent folders had a PLAN.md (`tierview` and `dubai-in-code`); tierview was chosen because its log says Phase 1 is done and Phase 2 is next.

**Delivered.** P2-01 to P2-08, all ticked in `PLAN.md`. `src/tier0/{diff,signals,score,route}.ts`, `src/git.ts`, `src/config.ts`, `src/prices.ts`, `src/estimate.ts`, `src/root.ts`, `src/output/{terminal,json}.ts`, and `src/cli.ts` (`review --dry-run [--json] [--max-cost]`; without `--dry-run` it exits 2 with "LLM tiers arrive in Phase 3"). 121 tests in 8 files; `npm run check` and `npm run build` pass. Fixtures in `test/fixtures/*.diff` were generated from a real git repo, and the dry-run snapshots are in `test/snapshots/`. All five worked examples in PLAN §4 pass as tests. A live `node dist/bin.js review --dry-run` on this repo's working tree also worked.

**Deviations from the plan, and why.**

1. **`--config` default.** No longer the literal `.tierview.yml`. With no flag, the loader looks for `.tierview.yml` in the current directory and uses the defaults if it is absent; an explicit `--config` pointing at a missing file is an error.
2. **`rules[].add`** was undefined in the plan. It is now a number of score points added before thresholds; `min_tier` / `max_tier` apply after.
3. **`signals:` in `.tierview.yml`** overrides a category (`auth: {weight: 45}`) or a structure signal (`churn: {enabled: false}`); an unknown name is a config error.
4. **Regex refinements in `config/default-rules.yml`** (allowed by CLAUDE.md; weights untouched): `\bf"` anchor for SQL f-strings; `eval(` / `exec(` no longer match `.eval(` / `.exec(` (they fired on `model.eval()` and `regex.exec()`); `can_?\w+` matched `canvas` and `cancel`, now only `can_x` or `canEdit`-style names; the `*.txt` docs glob excludes `requirements*.txt` so the dependencies signal can fire.
5. **`config/estimates.json`** gained placeholders the estimator needs (per-tier context tokens, shared-context tokens, Tier 1 batch limits). Still uncalibrated; P3-10 replaces them. The estimate ignores prompt caching and escalations; the 15% reserve is printed beside the total, not added to it.
6. **Docs files and comment-only hunks are capped at 5, not set to 5.** A one-line README change scores 0. This matches "capped" in the plan; noted because the worked example reads as if it scores 5.
7. **Dry-run JSON** has its own shape (`dry_run: true`, `routing`, `estimate`), not the full `Review` schema, which needs a receipt that does not exist before Phase 3.
8. **`src/tiers/batch.ts` is not used yet.** The estimator has a small private copy of the Tier 1 packing rule (12 hunks, 6k tokens). P3-03 should replace it with the real packer so the two cannot drift.

**Issues.**

- Keyword signals are blunt: on this repo's own diff, `estimate.ts` and `cli.ts` scored "payment" (`total` / `amount` words), `git.ts` scored "unsafe". Weights and patterns are Phase 4 work on the dev split; not touched here.
- `--dry-run` cannot tell "no history because shallow" from "diff supplied without git"; the note says "shallow clone or no checkout".
- Untracked files are not in `git diff`, so `review` does not see brand-new unstaged files. `git add -N` or `--staged` is the workaround; worth a README line in Phase 6.
- The first fixture attempt rewrote whole files with CRLF endings (Python on Windows); fixed by writing with `newline=''`.
- The first Phase 2 commit went in before this log entry was written (a script error); this entry is in the follow-up commit.

**API spend this phase.** $0 (no Anthropic API calls).

---

## Phase 3 — LLM tiers, escalation, receipt, backends (2026-11-16)

**Model.** Opus 5.5 (`claude-opus-5-5`), as planned.

**Effort.** High (stated by Mohamed in the prompt).

**Tooling.** Claude Code desktop app, Windows 11, Node 24.14; Claude Code CLI 2.1.322 (native install in `~/.local/bin`, not on PATH) for the live test.

**Prompt.** Verbatim:

<details>
<summary>Phase 3 prompt</summary>

Read PLAN.md and BUILD_LOG.md, then do Phase 3 with this change: I have no API key and won't create one. Add a pluggable backend layer:

1. `claude-code` backend (the default): run the official Claude Code CLI in non-interactive mode, with the tier's model, structured JSON output and no tools needed. Check the current Claude Code CLI docs for the exact flags. Only ever invoke the official `claude` binary; never read, copy or reuse its credentials. Batch hunks per tier to keep the number of calls low.
2. `api` backend: the Anthropic SDK with a user-supplied `ANTHROPIC_API_KEY`, kept for teams and the GitHub Action. Write it and unit-test it with mocks only; I can't run it live.
3. Cost receipt: for the claude-code backend, show tokens and "API-equivalent cost", including the all-Fable comparison.
4. Detect which models my plan allows in Claude Code. If Fable 5.2 isn't available, fall back to Opus 5.5 for Tier 3 and report it.
5. Add `--include-untracked` (new files are currently skipped).
6. Update PLAN.md: the benchmark becomes about 30 cases on the claude-code backend, run in batches across days within Pro limits, with no dollar budget; record usage per run.
7. Live-test only on small diffs, at most 5 `claude` calls total.
8. In BUILD_LOG, record Phase 1 as Fable 5.2 high, Phase 2 as Sonnet 5.5 medium and Phase 3 as Opus 5.5 high. Commit when done.

</details>

One follow-up question during the phase: before the live test I asked whether one Tier 3 call may go to Fable 5.2, because the docs say `claude -p` bills Fable to usage credits without asking on plans where Fable draws on them. Answer: **"Skip Fable, use Opus."** The live test ran Tier 3 on Opus 5.5 through a temporary config.

**Docs checked** (2026-11-16): `claude --help` (2.1.322); code.claude.com/docs/en/headless, cli-reference, model-config, agent-sdk/cost-tracking; the claude-api skill (refusal and fallback section, TypeScript SDK README). Facts used are in PLAN §5a.

**Delivered.** P3-01 to P3-10, all ticked. New: `src/llm/backend.ts` (interface), `src/llm/claude-code.ts` (backend, binary resolution and `--version` check, result parsing, model detection with `--fallback-model` and a 7-day cache in `~/.tierview/claude-code-models.json`, `probe`), `test/fake-client.ts`. Implemented: `src/llm/client.ts` (api backend), `src/llm/prompts.ts`, `src/tiers/{batch,context,escalate}.ts`, `src/budget.ts`, `src/merge.ts`, `src/receipt.ts`, `src/pipeline.ts`, review and receipt output in `src/output/{terminal,json}.ts`. CLI: `tierview review` now runs the tiers, with `--backend`, `--max-calls`, `--diff-file`, `--include-untracked`, `--fail-on`, `--json`, `--max-cost`, and `tierview models [--probe]`. 184 tests in 12 files (63 new); `npm run check` and `npm run build` pass. Both backends are tested with mocks only; the claude-code tests also replay one recorded live result (`test/fixtures/claude-result-tier1.json`, session id removed).

**Live test (P3-10), claude-code backend, 5 `claude` calls in total, Tier 3 on Opus:**

| Call | Diff | Tier, model, effort | Input-side tokens (input + cache write + cache read) | Output | API-equivalent | Result |
|---|---|---|---:|---:|---:|---|
| 1 | `seeded-bug-small.diff` | 1, Sonnet 5.5, low | 0 | 0 | $0 | failed, no usage reported (see Issues) |
| 2 | same | 1, Sonnet 5.5, low | 2 + 3,096 + 0 | 380 | $0.0162 | found the off-by-one (high); escalation stopped by `--max-calls 1` |
| 3 | `seeded-bug.diff` | 3, Opus 5.5, high | 2 + 3,273 + 0 | 573 | $0.0377 | SQL injection via f-string, critical, confidence 0.97 |
| 4 | same | 1, Sonnet 5.5, low | 2 + 2,138 + 994 | 364 | $0.0123 | off-by-one, high, escalated (E3) |
| 5 | same | 2, Opus 5.5, medium | 2 + 2,451 + 994 | 653 | $0.0329 | confirmed the off-by-one; Sonnet listed under "also reported by" |

Run of calls 3 to 5: 48.0 s wall, 11,446 tokens, $0.08 API-equivalent; both seeded bugs found, nothing else reported. Total for the phase: about $0.10 API-equivalent, **$0 billed** (Pro plan usage, no Fable). Each call had two turns (Claude Code's structured-output tool). The 994 cache-read tokens are Claude Code's own prefix from the previous call on the same model. tierview's tier prompts differ per tier, so they do not share a cache across tiers.

**Deviations from the plan, and why.**

1. **Backend layer (Mohamed's change).** New PLAN §5a; `claude-code` is the default; `api` is kept for teams and the Action. The interface is `ReviewBackend` in `src/llm/backend.ts`; only `src/llm/client.ts` imports the SDK.
2. **P3-10 rewritten.** The plan asked for an API run with `--max-cost 0.50` and a check that `cache_read_input_tokens > 0` on a multi-request tier. With no key, the run used the claude-code backend with at most 5 calls on two tiny diffs. Each tier sent one call, so the API caching rule (marker only at ≥ 2 requests, first request awaited) is unit-tested but **not verified live**.
3. **Server-side refusal fallback: not enabled** (the decision PLAN §5 left to this phase). The claude-api skill recommends `fallbacks: "default"` by default. tierview already escalates a refused hunk to the next tier's model, and a server-side switch inside a request would mix two models' output and prices in one review. Refusals stay explicit: E5 escalation, or `not_reviewed` at Tier 3.
4. **Receipt schema extended** (PLAN §8 updated): `backend`, `cost_basis` (`api_equivalent` on claude-code), `calls`, `model_substitutions`. `Usage` gained `cache_creation_1h_input_tokens`, because Claude Code on a plan writes 1-hour cache and those tokens cost `cache_write_1h`.
5. **Baseline model decoupled from Tier 3.** New config `receipt.baseline` (Fable 5.2 high). Without it, overriding Tier 3 to Opus turned "all-Fable" into "all-Opus", which the first live receipt showed.
6. **Config additions:** `backend` (default, claude-code batch limits and timeout, api max_tokens and concurrency) and `receipt.baseline`. `.tierview.example.yml` shows `backend`.
7. **Batching differs by backend.** api: as planned (Tier 1 packs, Tiers 2 and 3 one request per file). claude-code: every tier packs across files (40 hunks, 40k estimated tokens), concurrency 1. Each call carries about 2,100 tokens of Claude Code overhead, so fewer, bigger calls are cheaper and use less of the plan. `estimate.ts` now uses the real packer (closes Phase 2 deviation 8).
8. **Extra CLI options:** `--max-calls` (hard cap on model calls; needed to keep the live test at 5 and for Pro-limit batches), `--diff-file` (P3-10 needs a saved diff; Phase 4 will too), `tierview models [--probe]`.
9. **A blocked escalation keeps the lower tier's review.** When `--max-cost` or `--max-calls` stops an escalation, the hunk is not listed as `not_reviewed`; a note names it, and the exit code is still 3.
10. **Small rule choices:** E4b allows 3 lines of slack around the hunk (the diff's own context lines); `--fail-on` (exit 1) takes precedence over a budget stop (exit 3); claude-code's worst-case reservation assumes 32k output tokens, since `claude -p` has no max-tokens flag.
11. **`config/estimates.json` partly calibrated:** `system_prompt_tokens` 700 → 1000, Tier 1 output 250 → 400 (measured 364 and 380), new `claude_code_overhead_tokens_per_call` 2100. Tier 3 output on Fable was not measured, so `calibrated` stays false. Dry-run snapshots were regenerated: the claude-code plan now counts the overhead per call.
12. **PLAN §9 rewritten (Mohamed's change):** about 30 cases (20 buggy, 10 clean, 10 dev / 20 test, 5-case pilot) on the claude-code backend, batches across days capped by `--max-calls`, no dollar budget, `bench/results/usage.jsonl` per run. Fable arms only if Fable is available and approved, otherwise all-Fable is reported as an estimate. P4-04, P4-05, P4-08 and P4-10, §12 and the Phase 4 kickoff prompt were updated to match. The `CLAUDE.md` line about the "$ spend cap" now says "hard call cap per batch", and it asks before live `claude` calls too. Two README lines no longer say "nothing reviews code yet" or "bring your own key" only.

**Issues.**

- **The first live call was wasted.** zod 4 adds safe-integer `minimum`/`maximum` to `.int()` in `z.toJSONSchema`, and structured outputs reject numeric ranges. The call returned no usage in about 4 s. Most likely cause, not proven: the raw output was not kept. The schema is now cleaned (`cleanSchema`, tested), and the next call worked. The failure reason was also hidden, because the hunk escalated and then hit `--max-calls`, so it read "budget". Fixes: every failed call now adds a receipt note with its reason, and `TIERVIEW_DEBUG_DIR` dumps each raw `claude` result.
- **API-equivalent cost was 29% low at first.** It priced 1-hour cache writes at the 5-minute rate: $0.0115 against Claude Code's own $0.0162 on call 2. It is fixed and now matches to the cent; a test replays the recorded result.
- **Shell escaping mangled files twice.** Inline Python/Node edit scripts turned `\n` into real newlines and `\0` into a NUL byte (in `test/git.test.ts`, `src/git.ts`, `src/cli.ts`, `src/output/json.ts`). Typecheck caught all of them, and they were repaired. Later edits used script files or the editor.
- **Git-based tests timed out once** (the 10 s hook took 33 s on this machine). Timeouts were raised in `test/git.test.ts`.
- `npx tsx` was run once to print the generated schema. It is not a project dependency.
- **Not verified live:** the `api` backend as a whole (no key; mocked SDK only, though `zodOutputFormat(TierResponse)` builds without error under zod 4.6); Fable 5.2 through Claude Code (Mohamed chose to skip it); `--fallback-model` and the detection path (unit-tested with a fake runner; the live run never needed a fallback); `tierview models --probe`; `--include-untracked` end to end (tested on a temp repo, not in a live review).
- Keyword signals are still blunt (Phase 2 issue); not touched here.

**API spend this phase.** $0. Plan usage: 5 `claude -p` calls, about 14,900 tokens, about $0.10 API-equivalent.

---

## Fix before Phase 4 — Fable opt-in (2026-11-16)

**Model.** Opus 5.5 (`claude-opus-5-5`), high effort, in the Phase 4 chat, committed separately before Phase 4 work.

**Prompt.** The first part of the Phase 4 prompt (quoted in full in the Phase 4 entry): make Fable 5.2 opt-in on the claude-code backend with `--allow-fable` or `allowFable: true`; without it Tier 3 goes straight to Opus 5.5 and the receipt says "Tier 3 ran on Opus 5.5 (Fable not enabled)"; with it, warn before the first call; keep the all-Fable comparison.

**Delivered.** `src/fable.ts` (policy, display names, receipt line), `allowFable: false` in `config/default-rules.yml` and the config schema, `--allow-fable` on `review` and `models`, a guard in `ClaudeCodeBackend` that refuses to start a `claude` process for Fable without opt-in (requests, `--fallback-model` and `--probe`), dry-run note, receipt line, warning on stderr before the first call. Tests: `test/fable.test.ts` plus new cases in `test/backends.test.ts` and `test/pipeline.test.ts` (193 tests). Dry-run snapshots changed: Tier 3 now shows Opus 5.5 by default. PLAN §5a, README and `.tierview.example.yml` updated.

**Deviations.** The config key is camelCase (`allowFable`) because that is the name Mohamed asked for; every other key is snake_case. The substitute model is the Tier 2 model (Opus 5.5 by default), at Tier 3's own effort (high), so no new model ID enters the code.

**API spend.** $0, no `claude` calls.

---

## Phase 4 — benchmark (in progress, started 2026-11-16)

**Model.** Opus 5.5 (`claude-opus-5-5`). **Effort.** High.

**Prompt.** Verbatim:

<details>
<summary>Phase 4 prompt</summary>

Read PLAN.md and BUILD_LOG.md. First, a required fix before Phase 4: make Fable 5.2 opt-in. On the claude-code backend, never request Fable unless the user passes --allow-fable or sets allowFable: true in .tierview.yml. Without it, Tier 3 goes straight to Opus 5.5 (no Fable-first request), and the receipt says “Tier 3 ran on Opus 5.5 (Fable not enabled)”. With it, print a warning before the first call that Fable may use paid extra usage on some plans. The all-Fable comparison in the receipt stays (it’s only a calculation). Update the tests, PLAN.md and the README, and commit this separately.

Then do Phase 4 with these limits: I have no money, so no Fable calls at all (the benchmark compares tierview, all-Sonnet and all-Opus, plus the calculated all-Fable cost; drop the Fable low-effort arm and say why in PLAN.md). Build the 30-case dataset first, and show me the case list before running anything. Then run in batches of at most 20 claude calls per session, record usage in bench/results/usage.jsonl, and stop and report after each batch so I can continue in a later session when my usage resets. Tune the risk-scoring weights against the results (including the “payment” false positive on estimate.ts). Update BUILD_LOG (Opus 5.5, high) and commit.

</details>

**Session 1 (2026-11-16): Fable fix, plan changes, dataset. Zero `claude` calls.**

- Fable opt-in: separate commit and log entry above.
- PLAN §9, §11, §12, §13: three arms (`tierview`, `all-sonnet`, `all-opus`); no Fable calls; `all-fable-low` dropped with the reason; all-Fable cost calculated two ways; McNemar against `all-opus`; batches of at most 20 calls; the case list is shown before any call; planning estimate redone for three arms (about 8 to 11 batches).
- P4-01 `bench/mine.ts` + `bench/sources.json`: GitHub commit search (`gh api`, read-only) for fixes after 2026-07-01 in 11 repos; 531 links in `bench/candidates.jsonl`.
- P4-02 `bench/validate.ts`: size, merge, ancestry, language and blame checks against blobless clones in `bench/repos/` (not committed); clean-commit search; `make` writes the case files. Results in `bench/validated.jsonl` and `bench/clean.jsonl`.
- P4-03: manual pass; `bench/selection.json` (hand-written bug descriptions) and `bench/cases/` (30 `.json` + `.diff`), listed in `bench/cases/README.md`. 20 buggy (C 10, Python 4, Go 3, Rust 2, TypeScript 1), 10 clean; dev 10 incl. a 5-case pilot (3 buggy, 2 clean); at most 6 cases per repo. Fixes dated 2026-08-23 to 2026-11-13.
- `bench/routing.ts`: Tier 0 routing over the cases, no calls. **With the current weights only 4 of 20 faulty hunks reach Tier 2 or 3**; the other 16 go to Sonnet at low effort. This is the main input for weight tuning (P4-09, dev split only).
- Payment signal (Phase 2 issue): regex refinement, not a weight change. "checkout" and "ledger" left the content patterns (git checkout, a budget `Ledger` class), and `total =` / `price =` now need a money suffix (`total_cents`, `amountUsd`). Tests cover the estimate.ts lines. Weights are untouched until P4-09.
- Tests: `test/bench-dataset.test.ts` (extraction, diff and blame parsing, size rules, dataset invariants); 203 tests pass.

**Deviations so far, and why.**

1. **Bench scripts are bundled with tsup** (`npm run bench:build`, output in `.bench-build/`, ignored) instead of adding `tsx`; no new dependency.
2. **Sizes come from the GitHub commits API**, not local `git diff --numstat`: in a blobless clone each blob is fetched on demand, and validation took about 20 s per candidate. QEMU also needed `git backfill` (725 MB) before blame was fast enough.
3. **Validation stops at 10 good pairs per repo**, newest fixes first; not every candidate was checked.
4. **Clean commits are from 2025-08 to 2025-11**, not the bug commits' months, so the 12-month fix check has history to look at. Commits whose files saw more than 10 fix-labelled commits in that year were skipped to bound blame time; this biases the clean set toward calmer code (PLAN §9 updated).
5. **TypeScript is under-represented** (1 buggy case). Squash-merge TypeScript repos seldom name the PR that caused a bug; Angular's fixes were over 60 lines and MUI's links pointed at the fix's own PR.

**Issues.**

- An inline Python edit to `bench/mine.ts` silently failed to apply (escaped `\n` in a heredoc), so a later mining run overwrote `candidates.jsonl`. Re-mined (read-only search, same result plus the new repos); `validated.jsonl` was unaffected.
- The PR-reference pattern can match the fix's own PR number in its subject; the "B equals F" check rejects those (all 5 MUI links, 7 Next.js links).

**Usage so far.** $0; zero `claude` calls. GitHub API: about 1,100 read-only requests.

**Session 1, continued: harness. Zero `claude` calls.**

Mohamed approved the case list unchanged and asked for: a limitations section in `bench/cases/README.md` (C-heavy mix, older and calmer clean set so false-positive rates may be optimistic, only 7 dev bugs so the test split gives the headline numbers); a rule-based judge first, with Opus only for ambiguous findings and every judgement logged; then the arms, runner, judge and metrics, stopping before pilot batch 1.

- PLAN §9 judge rewritten: rules first (match within ±3 lines of a faulty line; no match in another file or more than 10 lines away outside every faulty hunk; ambiguous otherwise), Opus 5.5 `medium` only for ambiguous findings, one call per (case, arm), blind to arm and model; every judgement in `bench/results/judgements.jsonl`.
- `bench/cases/<id>.fix.diff` for the 20 buggy cases (the judge sees the fix; the reviewer never does).
- P4-04 `bench/arms.ts`: `tierview` (Fable policy applied, Tier 3 on Opus high), `all-sonnet` (Sonnet low), `all-opus` (Opus medium); baselines route every non-generated hunk to Tier 3 with a `min_tier: 3` rule. Model IDs come from the config.
- P4-05 `bench/run.ts`: batches of 1 to 20 calls (above 20 is refused); review and judge calls share the cap; runs that do not fit are left for the next batch; the pipeline's `maxCalls` is the hard stop; a usage-limit or rate-limit error stops the batch and leaves the run incomplete; finished runs are never re-run; pending judgements are finished first in the next batch. Per run: `bench/results/runs/<case>__<arm>.json`; per run and judge call: `bench/results/usage.jsonl`; per batch: `bench/results/batches.jsonl`. `--dry-run` plans a batch with zero calls. Raw `claude` results go to `bench/results/raw/` (ignored).
- P4-06 `bench/judge.ts`: location rule, judge prompt and schema, audit sampler. `runStructured` added to `src/llm/claude-code.ts` for the judge's schema (same isolation flags; refuses Fable).
- P4-07 `bench/metrics.ts`: recall with bootstrap 95% CI, exact McNemar (tierview vs all-opus), false positives per clean case (severity ≥ medium), unmatched findings, tokens, API-equivalent cost per case and per bug caught, calls, latency p50/p90, escalation rate, routing recall, receipt-estimator error against all-Opus, and the calculated all-Fable cost two ways.
- Tests: `test/bench-run.test.ts` (fake backend and fake judge only); 212 tests pass.
- Dry run of pilot batch 1: 8 of the 15 pilot runs fit in 20 planned calls; the whole pilot is planned at about 36 calls (two batches), before escalations and retries.

**Deviations.** 6. The judge is rule-first with Opus for ambiguous cases (Mohamed's decision), not Sonnet `medium` for every finding near the fault. 7. The benchmark runs from saved diffs, so churn and hotspot signals are off in every arm; tierview on a real checkout would score some hunks higher. 8. The receipt estimator prices API-shaped requests, while the all-Opus arm runs through Claude Code (about 2,100 overhead tokens per call), so its measured error includes that overhead; the write-up must say so.

**Next.** Pilot batch 1 (`node .bench-build/run.js --cases pilot`), only when Mohamed starts it.

---

*Template for each later phase:*

**Model.** …
**Effort.** …
**Prompt.** … (verbatim, or the kickoff prompt from PLAN §13 plus any follow-ups)
**Delivered.** …
**Deviations from the plan, and why.** …
**Issues.** …
**API spend this phase.** …
