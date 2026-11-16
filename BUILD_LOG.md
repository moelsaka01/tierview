# Build log

One entry per phase: which model did the work, at what effort, from what prompt, and what went wrong or changed. Each phase runs in a fresh chat; the plan is [PLAN.md](PLAN.md).

| Phase | Scope | Model (effort) | Status |
|---|---|---|---|
| 1 | Plan and scaffold | Fable 5.2 (high) | done 2026-11-16 |
| 2 | Tier 0, config, dry-run | Sonnet 5.5 (medium) | done 2026-11-16 |
| 3 | LLM tiers, escalation, receipt, backends | Opus 5.5 (high) | done 2026-11-16 |
| 4 | Benchmark | Opus 5.5 (high) | in progress: dev split done; `bench-config-v2` frozen; test split 30 of 60 runs valid |
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

**Pilot batch 1 (2026-11-16, started by Mohamed: "Run pilot batch 1").** 19 `claude` calls (cap 20), 0 judge calls (the rules decided every finding), no Fable, no errors. 12 of the 15 pilot runs complete; the 3 Tailscale runs (about 5 + 2 + 2 calls planned) did not fit and wait for batch 2. API-equivalent $2.80 in total; $0 billed (plan usage). Ledger: `bench/results/usage.jsonl`, `batches.jsonl`, `judgements.jsonl`, `runs/`.

| case | arm | calls | tokens | API-eq | wall |
|---|---|---:|---:|---:|---:|
| cilium-clean-fqdn-bootstrap | tierview / all-sonnet / all-opus | 1 / 1 / 1 | 3,968 / 12,485 / 13,486 | $0.017 / $0.048 / $0.124 | 10 / 14 / 23 s |
| django-legend-attrs-mutation | tierview / all-sonnet / all-opus | 2 / 2 / 2 | 18,835 / 74,066 / 74,522 | $0.117 / $0.294 / $0.597 | 42 / 59 / 38 s |
| dpdk-ntb-window-bound | tierview / all-sonnet / all-opus | 4 / 1 / 1 | 66,226 / 58,515 / 62,404 | $0.623 / $0.245 / $0.568 | 169 / 28 / 74 s |
| nextjs-clean-default-export-errors | tierview / all-sonnet / all-opus | 2 / 1 / 1 | 9,410 / 8,610 / 9,393 | $0.051 / $0.032 / $0.080 | 24 / 10 / 20 s |

What the 4 complete pilot cases show (far too few for any claim):
- All three arms caught both bugs; no arm raised a finding of medium or higher on the two clean cases (all-opus raised one "low").
- Mean API-equivalent cost per case: tierview $0.20, all-sonnet $0.15, all-opus $0.34. On `dpdk-ntb-window-bound` tierview cost more than all-opus: 4 calls (Tier 1, Tier 2, then escalations to Tier 2 and Tier 3), each carrying Claude Code's overhead and growing context.
- Calculated all-Fable per case: receipt estimate $0.72; all-opus tokens at Fable prices $0.47. The receipt estimator looks high.
- **"Unmatched" is not "false".** On `dpdk-ntb-window-bound` the arms raised 6 to 7 findings in `ntb.c` that the rules marked "no match" (no faulty line there). Several describe the Rx bug that a second fix of the same commit repaired (`e79842a253`, "raw/ntb: fix Rx of incomplete packets"), which the manual pass left out by keeping one fix per bug commit. This does not change recall. It does mean that unmatched counts on buggy cases must not be read as false positives (PLAN §9 already says so).

Projection from measured calls per case (tierview 2.3, each baseline 1.3, judge about 0): about 5 calls per case for the three arms. Pilot batch 2 needs about 9 calls. The other 25 cases need about 125 calls, so roughly 7 more batches of 20, before any re-runs.

**Pipeline v2, before pilot batch 2 (Mohamed's changes, no `claude` calls).** Prompt: "Don't run pilot batch 2 yet. First fix these, with tests and no claude calls: (1) when Fable is off, merge Tier 2 and Tier 3 into one Opus call at the higher effort; (2) make escalation whole-diff: run all Sonnet batches first, then send every escalated hunk to a single Opus call; (3) compute the all-Fable figure one way only, as the actual tokens priced at Fable rates, everywhere (receipt and metrics); (4) report both "via Claude Code" cost and "direct API" cost (without the ~2,100-token per-call overhead) in the receipt and metrics. Re-run the pilot metrics from the saved results where possible, update BUILD_LOG and PLAN.md, and commit. Then run pilot batch 2, and stop and report." (followed by "run batch yourself").

1. **Tier merge** (`src/tiers/collapse.ts`): when Tier 2 and Tier 3 run the same model, Tier 2 hunks join Tier 3 at the higher effort; Tier 1 escalates straight to it; a budget degrade moves Tier 3 straight to Tier 1; the dry run notes it. Applied in the pipeline, the estimator and the bench's call planner.
2. **Whole-diff escalation** (`src/pipeline.ts`): Tier 1 first, then each higher tier once with its own hunks plus all escalated hunks. To keep "riskiest first" under a cap, the higher tiers' calls and worst-case cost are held back while lower tiers run, and own-hunk packs go before escalation-only packs. On the `api` backend Tiers 2 and 3 still send one request per file, so "one Opus call" holds on `claude-code` (cross-file packing).
3. **All-Fable, one method** (`src/costs.ts`): actual tokens at the baseline model's rates, in the receipt (`method: "actual_tokens_at_baseline_prices"`), the dry run (its estimated tokens) and the metrics (the all-opus arm's tokens for the headline, every arm's own tokens listed). `estimateBaseline` and the estimator-error metric are removed. Caveat now in PLAN §7: the same tokens at Fable rates understate a real all-Fable run, which would send every hunk with Tier 3 context.
4. **Two cost views**: via Claude Code (what ran) and direct API (minus 2,100 overhead tokens per call, rest at the uncached input rate) per tier and in total, in the receipt, the dry run, `usage.jsonl` (`direct_api_usd`) and the metrics.
5. **Bench**: `ARM_VERSION` (tierview v2); stale or incomplete runs are archived to `bench/results/runs-archive/` before a re-run; metrics reads both folders and shows old versions as their own row; judgements carry `run_batch` so a judgement counts only for the run it judged. Receipt schema: `cache_write_1h_tokens`, `direct_api_cost_usd`, `total_direct_api_cost_usd`, `baseline.direct_api_cost_usd` (PLAN §8).
6. Tests: `test/costs.test.ts` (cost views, merge, degrade), new runner tests (one Sonnet + one Opus call per case, stale re-run and archive, judgement scoping), updated order tests; dry-run snapshots regenerated. 219 tests pass.

**Pilot metrics recomputed from saved results (dev split, no calls).** The 4 saved tierview runs are v1 (old pipeline), shown as `tierview@v1`, and will be re-run in batch 2; the baseline arms are unaffected by the change and stay.

| arm | runs | recall | FP / clean | calls / case | $ / case via Claude Code | $ / case direct API | same tokens at Fable rates (CC / direct) |
|---|---:|---|---:|---:|---:|---:|---|
| all-sonnet | 4 | 2/2 | 0 | 1.3 | $0.155 | $0.082 | $0.618 / $0.326 |
| all-opus | 4 | 2/2 | 0 | 1.3 | $0.342 | $0.194 | $0.684 / $0.388 |
| tierview@v1 | 4 | 2/2 | 0 | 2.3 | $0.202 | $0.135 | $0.465 / $0.303 |

Direct API is about half of via-Claude-Code: the per-call overhead is written to Claude Code's 1-hour cache, priced at 2x input. Headline all-Fable (all-opus tokens at Fable rates): $0.68 per case via Claude Code, $0.39 direct API.

**Pilot batch 2 (2026-11-16, run by me at Mohamed's request: "run batch yourself").** 12 `claude` calls (cap 20): 11 reviews and 1 Opus judge call; no Fable, no errors. 17 calls had been planned (escalation and judge reservations not all used). API-equivalent $0.93 via Claude Code. It re-ran the 4 tierview pilot cases on pipeline v2 (old runs archived in `bench/results/runs-archive/`) and ran the 3 Tailscale runs. The pilot is complete: 15 runs, all current.

| case | arm | calls | tokens | via Claude Code | direct API | wall |
|---|---|---:|---:|---:|---:|---:|
| cilium-clean-fqdn-bootstrap | tierview | 2 | 12,622 | $0.070 | $0.037 | 22 s |
| django-legend-attrs-mutation | tierview | 1 | 11,783 | $0.020 | $0.033 | 18 s |
| dpdk-ntb-window-bound | tierview | 2 | 45,323 | $0.427 | $0.296 | 107 s |
| nextjs-clean-default-export-errors | tierview | 2 | 11,322 | $0.060 | $0.035 | 34 s |
| tailscale-halfclose-shutdown | tierview / all-sonnet / all-opus | 2 / 1 / 1 | 15,492 / 14,821 / 16,569 | $0.140 / $0.059 / $0.153 | $0.098 / $0.031 / $0.096 | 60 / 14 / 33 s |
| tailscale-halfclose-shutdown | judge (tierview) | 1 | 3,155 | $0.027 | $0.027 | 10 s |

**Pilot results, 5 cases (3 buggy, 2 clean), dev split.** Far too small for claims; recorded to steer the next steps.

| arm | recall | FP / clean | calls / case | $ / case via Claude Code | $ / case direct API | same tokens at Fable rates (CC / direct) |
|---|---|---:|---:|---:|---:|---|
| tierview (v2) | 2/3 | 0 | 1.8 | $0.143 | $0.100 | $0.316 / $0.226 |
| all-sonnet | 2/3 | 0 | 1.2 | $0.136 | $0.071 | $0.542 / $0.286 |
| all-opus | 3/3 | 0 | 1.2 | $0.304 | $0.174 | $0.608 / $0.349 |

Observations:
- **Pipeline v2 works as intended:** every tierview run is at most one Sonnet call and one Opus call (was up to 4 calls). On `dpdk-ntb-window-bound` it now costs $0.43 instead of $0.62, below all-opus ($0.57 in batch 1).
- **tierview missed the Django bug this time.** Its faulty hunk scores 0 and goes to Sonnet at low effort; in batch 1 Sonnet flagged it and escalated, in batch 2 it raised nothing. Same input, different answer: run-to-run variance at Tier 1 is real and one run per (case, arm) cannot measure it. This is also the routing-recall problem (1 of 7 dev bugs routed to Tier 2+).
- **The location rule may be lenient.** On Tailscale, the faulty lines span about 20 lines, and the findings matched by rule (for tierview and all-opus) describe related half-close problems in that block, not obviously the ENOTCONN failure the fix addresses. The one ambiguous finding went to Opus, which said "no match". The hand audit of 20 judgements (PLAN §9) must check rule matches too; tightening the rule for wide faulty regions is an option.
- **Direct API can exceed via Claude Code** when a call gets Claude Code cache hits (Django: $0.033 vs $0.020): the direct view prices all non-overhead input at the uncached rate. Documented behaviour of the formula, not a bug.

Projection from the pilot: about 1.8 + 1.2 + 1.2 = 4.2 review calls per case plus about 0.2 judge calls per buggy case, so the other 25 cases need about 110 calls, roughly 6 batches of 20.

**Next.** Stop and ask Mohamed before the full run (P4-08). Open questions for him: whether to tighten the match rule before more judgements accumulate, and whether to tune routing on the dev split (P4-09) before running the test split.

**P4-09 routing tuning (2026-11-16, Mohamed: "Tune routing on dev first"). Dev split only, zero `claude` calls.**

Method: `bench/tune.ts` reports, for a config, the dev routing recall (faulty hunk at Tier 2+) and the share of reviewable hunks sent to Opus (the cost driver), overall and on clean cases; `bench/tune-grid.ts` compares variants. The test split was not routed or looked at while tuning.

What the 7 dev bugs look like at Tier 0 (before): six faulty hunks scored 0 to 15 (size and "no tests changed" only); only Tailscale (concurrency) reached Opus. The bugs are ordinary logic bugs: a flag dropped from an `if` mask (bnxt), a `<=` bounds check in new code (ntb), a macro argument (MOV width), a dict no longer copied (Django legend), a regex (Django verbatim), an IRQ never freed (i8259).

Changes (general bug classes, not patterns for one case):
1. `boundary` gains two logic signals: `condition_changed` (an if/while/for condition rewritten on a modified line) and `bounds_check_added` (a new spaced `<`/`<=`/`>`/`>=` against arithmetic or a size-like name). Weight 10 → 25: off-by-one and broken conditions are as risky as the other 25-point classes.
2. New `memory` category, weight 25: allocation, free and lifetime calls (C, glib, DPDK-style `*_alloc(`/`*_free(`, Rust raw-box and `mem::forget`). It does not change any dev result; it is in because memory management is a classic risk the Phase 1 list missed.
3. Tier 2 threshold 30 → 25 (with Fable off this is the Opus threshold; Tier 3's 60 is moot when merged).

| config | dev routing recall | dev hunks to Opus (all / clean) |
|---|---|---|
| before (boundary 10, threshold 30) | 1/7 | 9% / 0% |
| boundary 20, threshold 30 | 2/7 | 19% / 0% |
| **chosen: boundary 25, memory 25, threshold 25** | **3/7** (bnxt, ntb, Tailscale) | **25% / 14%** |
| boundary 30, threshold 20 | 3/7 | 25% / 14% |

The other four dev bugs (MOV width, Django legend, Django verbatim, i8259 IRQ) have no Tier 0 signal at all; no weight change reaches them without sending most hunks to Opus. They depend on Sonnet raising them (and escalating), which batch 1 vs batch 2 showed is not reliable. This is the main limit of keyword routing and the README must say so.

Not tuned: escalation confidence thresholds. Only 5 tierview v2 pilot runs exist on dev, too few to fit anything; they stay at 0.7 / 0.6.

Caveat on independence: I chose the dataset (and so read the one-line descriptions of the test bugs) before tuning. The new signals target general classes, and no test diff was routed during tuning, but a reader should know the tuner had seen the test bug list. 7 dev bugs are also too few to tune well (cases README, Limitations).

Frozen: config hash `8b8d0f208dd5`; tierview arm version 3, so the 5 tierview pilot runs (v2, old weights) are stale and re-run in the next batch (about 9 calls); the baseline arms do not depend on routing and stay. Tests: new signal cases in `test/signals.test.ts`; threshold tests updated; 229 tests pass.

**Next.** Ask Mohamed: whether to tighten the location match rule before more judgements accumulate, then the test split in batches of 20 (about 6 batches) plus the dev re-runs.

**Judge v2 and freeze (2026-11-16). Zero `claude` calls.** Prompt: "Tighten it first, with no claude calls. For fixes whose changed lines span more than ~8 lines, a location match alone isn't enough; the finding must describe the same mechanism as the fix (rule check on key terms from the fix/bug description, otherwise send it to Opus as ambiguous, logged). Apply it identically to all three arms, and re-judge the existing pilot runs under the new rule (re-using saved findings; only ambiguous cases need Opus calls; count them). Freeze the judge too: include it in the config hash and tag bench-config-v1. Update PLAN.md and BUILD_LOG, commit, then stop and show me how the pilot catches changed."

- Rule (`bench/judge.ts`, `JUDGE_VERSION` 2): a fix is wide when its faulty lines in a file span more than 8 lines (6 of 20 buggy cases: Tailscale on dev; prefault, Django lookup, DPDK mem, DPDK procinfo, Tetragon on test). For those, a location match also needs at least 2 mechanism terms in the finding's text, otherwise it is ambiguous (Opus). Mechanism terms are bug-description and fix-subject words, stemmed, minus stopwords, minus every word that occurs in the reviewed diff. Same rule for all arms.
- Two fixes to the term extraction before freezing, found while checking the terms: identifiers like `backendSocket` hid their parts, so "socket" passed as a mechanism term (now split at `_` and camelCase); and generic outcome words (fail, crash, later…) counted (now stopwords). I also first tried "at least 1 term": the all-Opus Tailscale finding then matched on the single word "half" while describing copy-error handling, so the threshold is 2. These choices were made after seeing the 3 dev pilot runs' findings and the mechanism-term lists of all 6 wide cases (not any test-split findings, which do not exist yet).
- Re-judge (`node .bench-build/run.js --rejudge`): 11 saved buggy runs (runs/ and runs-archive/), 39 findings, no calls: 11 rule matches, 24 rule no-matches, 4 ambiguous; 1 reused an earlier Opus verdict (same finding, same prompt), **3 pending, needing 2 Opus calls** (one per run), not made. Only the all-Opus run is current; the tierview@v2 run is stale (arm v3) and will be re-run anyway, so **1 Opus judge call** is really needed, in the next batch.
- How the pilot catches changed (judge v1 → v2): unchanged everywhere except **Tailscale / all-opus: caught → pending** (its two rule matches lacked mechanism terms: "copy error handled as a half-close", "non-tcpCloser backend never gets EOF"). Tailscale / tierview@v2 stays caught on a rule match with terms "half, shutdown"; all-sonnet still misses it. Current dev recall: all-sonnet 2/3, all-opus 2/3 (1 pending), tierview needs its v3 re-run.
- Frozen: judge included in the config hash (`judgeConfig()`); hash `3f0786b02d0a`; git tag `bench-config-v1`. Tests: `test/judge-v2.test.ts` (terms, wide rule for all arms, hash, re-judge reuse and idempotency); 235 tests pass.

**Next.** Ask Mohamed to start the next batch: the dev re-runs (5 tierview v3 runs, the pending Opus judge call) and then the test split, about 6 to 7 batches of 20.

**Batch 3 (2026-11-16, Mohamed: "Run next batch"; `--cases pilot` on `bench-config-v1`).** 11 `claude` calls (cap 20; 14 planned): 9 reviews and 2 Opus judge calls; no Fable, no errors. API-equivalent $0.76 via Claude Code. It re-ran the 5 tierview pilot cases on the frozen config (v3; the v2 runs moved to `runs-archive/`) and judged the pending findings.

| case | arm | calls | tokens | via Claude Code | direct API | wall |
|---|---|---:|---:|---:|---:|---:|
| tailscale-halfclose-shutdown | judge (all-opus) | 1 | 3,507 | $0.025 | $0.025 | 12 s |
| cilium-clean-fqdn-bootstrap | tierview | 1 | 3,964 | $0.005 | $0.006 | 11 s |
| django-legend-attrs-mutation | tierview | 2 | 19,444 | $0.115 | $0.061 | 28 s |
| dpdk-ntb-window-bound | tierview | 2 | 45,315 | $0.442 | $0.313 | 115 s |
| nextjs-clean-default-export-errors | tierview | 2 | 11,166 | $0.073 | $0.039 | 27 s |
| tailscale-halfclose-shutdown | tierview | 2 | 14,776 | $0.126 | $0.084 | 51 s |
| tailscale-halfclose-shutdown | judge (tierview) | 1 | 3,676 | $0.026 | $0.026 | 13 s |

Judge outcomes: all four ambiguous Tailscale findings (two all-opus, two tierview v3) were judged "no match" by Opus: they describe hangs when a backend never gets EOF or a copy error half-closes one side, not the `shutdown(SHUT_RD)` / ENOTCONN failure the fix addresses. So **no arm catches the Tailscale bug under judge v2**.

**Pilot on the frozen config (5 dev cases: 3 buggy, 2 clean):**

| arm | caught | FP / clean | calls / case | $ / case via Claude Code | $ / case direct API |
|---|---|---:|---:|---:|---:|
| tierview v3 | 1/3 (ntb) | 0 | 1.8 | $0.152 | $0.100 |
| all-sonnet | 2/3 (ntb, Django legend) | 0 | 1.2 | $0.136 | $0.071 |
| all-opus | 2/3 (ntb, Django legend) | 0 | 1.2 | $0.304 | $0.174 |

- tierview missed the Django legend bug again: its hunk scores 0 (Tier 1, Sonnet low), Sonnet at low effort with no context did not flag it in either v2 or v3, while all-sonnet (Sonnet low, Tier 3 shape with file context) did. On this case the missing context, not the model, looks like the difference.
- The tierview v1 run that caught it did so by Sonnet escalating; v1 vs v2 vs v3 show the same input getting different Tier 1 answers.
- Calls per pilot run so far: 19 + 12 + 11 = 42 calls in three batches, including re-runs and judging.

**Next.** Stop and report. Remaining: the other 5 dev cases (15 runs) and the 20 test cases (60 runs), about 4.2 review calls per case plus judge calls: about 6 to 7 batches of 20.

**Batch 4 (2026-11-16, Mohamed: "Run next batch"; `--cases dev` on `bench-config-v1`).** 19 `claude` calls (cap 20; the dry run planned 9 runs in 20 calls, but runs used fewer calls than reserved, so all 15 remaining dev runs fit): 18 reviews and 1 Opus judge call; no Fable, no errors. API-equivalent $2.15 via Claude Code. **The dev split is complete** (10 cases x 3 arms).

| case | tierview | all-sonnet | all-opus |
|---|---|---|---|
| ch-mov-imm32-store | caught (2 calls, $0.263) | caught (1, $0.095) | caught (1, $0.221) |
| django-verbatim-no-spaces | missed (2, $0.207) | caught (1, $0.149) | caught (1, $0.368) |
| dpdk-bnxt-short-bd-checksum | caught (1, $0.091) | caught (1, $0.035) | caught (1, $0.037) |
| qemu-i8259-irq-leak | missed (2, $0.123) | missed (1, $0.090) | missed (1, $0.263; 1 judge call: "no match") |
| qemu-clean-physmem-dirty-range | 0 FP (1, $0.016) | 0 FP (1, $0.063) | 0 FP (1, $0.132) |

**Dev split, all 10 cases (tuning data, not the headline):**

| arm | recall (95% CI) | FP / clean | calls / case | $ / case via Claude Code | $ / case direct API | $ / bug caught via CC |
|---|---|---:|---:|---:|---:|---:|
| tierview v3 | 3/7 = 43% (14–86%) | 0 | 1.7 | $0.146 | $0.098 | $0.456 |
| all-sonnet | 5/7 = 71% (43–100%) | 0 | 1.1 | $0.111 | $0.060 | $0.194 |
| all-opus | 5/7 = 71% (43–100%) | 0 | 1.1 | $0.254 | $0.155 | $0.441 |

McNemar tierview vs all-opus: both 3, opus only 2, tierview only 0, neither 2; p = 0.5. All-Fable (all-opus tokens at Fable rates): $0.51 per case via Claude Code, $0.31 direct API.

What the dev split says (7 bugs; a pattern to test, not a result):
- **tierview's two extra misses are the same failure:** Django legend and Django verbatim both sit in hunks routed to Tier 1, where Sonnet sees the diff with no file context and raised nothing. all-sonnet (same model and effort, Tier 3 context) caught both. The bnxt bug was caught by tierview only because P4-09 routed it to Opus.
- **all-sonnet matches all-opus recall at 44% of the cost** on dev. Cost per case: all-sonnet < tierview < all-opus; tierview pays for two calls (Claude Code overhead twice) on most cases.
- No arm raised a false positive (medium or higher) on the 3 clean dev cases.
- Both i8259 and Tailscale are missed by every arm.

Implication (not acted on; needs Mohamed's decision because the config is frozen and the test split must not be used for it): the weak link is Tier 1's missing context, not the router or the model. Giving Tier 1 the Tier 3 context shape would make tierview's Tier 1 equal to all-sonnet on those hunks; that is a design change (unfreeze, bump to `bench-config-v2`, re-run tierview on dev) and should be decided before the test split runs.

**Next.** Stop and report. Remaining: 20 test cases (60 runs), about 4 batches of 20 at the measured 1.1 to 1.7 calls per run.

**bench-config-v2 (2026-11-16). Decided from dev-split results, before any test-split run. Zero `claude` calls for the change.** Prompt: "Give Tier 1 the same file context as Tier 3, with no other changes. Also skip the Opus call entirely when no hunk was routed to Opus and Sonnet escalated nothing, so those runs cost one call like all-Sonnet. Bump to bench-config-v2 (new hash and tag), and record in PLAN.md and BUILD_LOG that this change was decided from dev results before any test run. Re-run tierview on the dev split only, then stop and show me the dev table before the test split."

- Tier 1 context: config `tier1_context` (`none` | `tier3`, default `tier3`); `contextFor` gives Tier 1 exactly Tier 3's block; the estimator uses Tier 3's context tokens for Tier 1. One companion edit: the Tier 1 prompt said "You see each hunk with only the diff's own three lines of context", which would contradict the new input, so with `tier3` that sentence reads "the same file context as Tier 3: the whole file when it is short, otherwise about 80 lines around the hunk and the start of the enclosing function". The rest of the prompt, routing, models, efforts and escalation are unchanged.
- Opus call skip: already the pipeline's behaviour (Tier 3 sends nothing when it has no routed or escalated hunk); now covered by a test (a clean case with nothing routed to Opus makes exactly 1 call). The dev runs with 2 calls all had hunks routed to Opus or escalated. The runner's planner still reserves an Opus call for a possible escalation; that is planning only and spends nothing.
- Frozen: config hash `4fe1abf9f1f3`, git tag `bench-config-v2`; tierview arm version 4 (its dev runs are stale and re-run; the baseline arms do not depend on this setting). Dry-run snapshots regenerated (Tier 1 estimate now includes context tokens). 239 tests pass.

**Batch 5 (2026-11-16, tierview only, dev split, `bench-config-v2`).** 19 `claude` calls (cap 20; 20 planned with reservations): 18 reviews and 1 Opus judge call (Tailscale: both ambiguous findings "no match"); no Fable, no errors. API-equivalent $1.61 via Claude Code. All 10 tierview dev runs are v4.

| case | calls | tokens | via Claude Code | direct API | result |
|---|---:|---:|---:|---:|---|
| ch-mov-imm32-store | 2 | 33,197 | $0.259 | $0.172 | caught |
| django-legend-attrs-mutation | 3 | 77,769 | $0.283 | $0.177 | **caught** (missed in v2 and v3) |
| django-verbatim-no-spaces | 2 | 49,166 | $0.360 | $0.262 | **caught** (missed in v3) |
| dpdk-bnxt-short-bd-checksum | 1 | 9,433 | $0.050 | $0.065 | caught |
| dpdk-ntb-window-bound | 2 | 66,816 | $0.270 | $0.306 | caught |
| qemu-i8259-irq-leak | 2 | 26,098 | $0.114 | $0.097 | missed |
| tailscale-halfclose-shutdown | 2 | 21,086 | $0.114 | $0.115 | missed (Opus judge: no match) |
| cilium-clean-fqdn-bootstrap | 1 | 12,323 | $0.047 | $0.022 | 0 FP |
| nextjs-clean-default-export-errors | 2 | 12,900 | $0.050 | $0.050 | 0 FP |
| qemu-clean-physmem-dirty-range | 1 | 16,290 | $0.063 | $0.031 | 0 FP |

**Dev split, final (tuning data; test split not run):**

| arm | recall (95% CI) | FP / clean | calls / case | $ / case via Claude Code | $ / case direct API | $ / bug caught (CC / direct) |
|---|---|---:|---:|---:|---:|---|
| tierview v4 (`bench-config-v2`) | 5/7 = 71% (43–100%) | 0 | 1.8 | $0.161 | $0.130 | $0.290 / $0.239 |
| all-sonnet | 5/7 = 71% (43–100%) | 0 | 1.1 | $0.111 | $0.060 | $0.194 / $0.105 |
| all-opus | 5/7 = 71% (43–100%) | 0 | 1.1 | $0.254 | $0.155 | $0.441 / $0.274 |
| tierview v3 (`bench-config-v1`, for comparison) | 3/7 = 43% (14–86%) | 0 | 1.7 | $0.146 | $0.098 | $0.456 / $0.309 |

McNemar tierview v4 vs all-opus: both 5, neither 2, no discordant pairs (p = 1). All three arms catch the same 5 dev bugs and miss the same 2 (i8259, Tailscale).

- The Tier 1 context change recovered both Django misses: tierview now matches both baselines on dev recall.
- **Cost on dev: all-sonnet is cheapest** ($0.111 via Claude Code, $0.060 direct), then tierview ($0.161 / $0.130), then all-opus ($0.254 / $0.155). Tier 1 now carries file context (about 1.8x the tokens of v3) and most cases still make a second, Opus call; Django legend needed 2 Tier 1 calls because its 15 hunks with context passed the 40k-token pack limit. On the direct-API basis tierview is close to all-opus.
- On 7 dev bugs none of these differences in recall is measurable; the cost ordering is the clearer signal, and it does not favour the cascade on this split.

**Next.** Stop and show Mohamed the dev table before the test split (20 cases, 60 runs, about 4 to 5 batches).

**Test batch 1 (2026-11-16, Mohamed: "Run test batch 1"; `--cases test` on `bench-config-v2`, hash `4fe1abf9f1f3` checked before the run).** 20 `claude` calls (cap 20): 15 reviews and 5 Opus judge calls; no Fable, no errors. API-equivalent $1.63 via Claude Code. 4 of 20 test cases done (12 of 60 runs); stopped at the cap with 48 runs (about 97 planned calls) left.

| case | tierview | all-sonnet | all-opus |
|---|---|---|---|
| ch-prefault-thread-startup (buggy, wide) | missed: 2 findings, Opus judge "no match" (2 calls, $0.334) | missed: 1 finding, judge "no match" (1, $0.158) | missed: 2 findings, judge "no match" (1, $0.351) |
| cilium-mtu-portmap-warning (buggy) | **caught** by rule ("empty chaining mode is not treated as no chaining", on the faulty line) (2, $0.134) | missed: no findings (1, $0.053) | missed: 1 finding (IPsec not covered), judge "no match" (1, $0.124) |
| cilium-clean-wireguard-margin | 0 findings (1, $0.051) | 0 (1, $0.051) | 0 (1, $0.107) |
| django-clean-keytexttransform-mysql | 0 findings (2, $0.110) | 0 (1, $0.042) | **1 medium finding (FP)** (1, $0.119) |

Judge calls: 5 (one per run with ambiguous findings), $0.093 together. Interim only; no metrics are computed on 4 test cases.

**Test batch 2 (2026-11-16, Mohamed: "Run test batch 2"; hash `4fe1abf9f1f3` verified by the command before running).** 19 `claude` calls (cap 20): 19 reviews, 0 judge calls (the rules decided every finding); no Fable, no errors. API-equivalent $2.02 via Claude Code. 14 more runs: test cases 5 to 8 complete, and 2 of 3 arms of `dpdk-hws-counter-double-free` (all-opus did not fit: 2 calls planned, 1 left). Total so far on the test split: 26 of 60 runs, 39 calls.

| case | tierview | all-sonnet | all-opus |
|---|---|---|---|
| django-clean-migration-determinism | 0 findings (2 calls, $0.161) | 0 (1, $0.070) | 0 (1, $0.149) |
| django-jsonfield-in-value-none (buggy) | **caught** (2, $0.214) | missed: no findings (1, $0.046) | **caught** (1, $0.127) |
| django-lookup-rhs-iterator (buggy, wide) | **caught**: rule match with mechanism terms "empty, iterator" (2, $0.196) | missed: no findings (1, $0.081) | missed: no findings (1, $0.204) |
| dpdk-clean-dpaa2-prefetch | 0 (2, $0.221) | 0 (1, $0.112) | **1 medium finding (FP)** (1, $0.260) |
| dpdk-hws-counter-double-free (buggy) | **caught** (2, $0.124) | **caught** (1, $0.052) | next batch |

**Next.** Test batch 3, started by Mohamed. 34 runs left, about 70 planned calls.

**Test batch 3 (2026-11-16, Mohamed: "Run test batch 3"; hash verified). Partly invalid: the plan's 5-hour usage limit hit mid-batch and the runner did not notice.** The batch reported 20 `claude` calls (19 reviews, 1 judge), $1.60 API-equivalent. About 6 calls did real work; after that every `claude -p` call returned at once with "You've hit your 5-hour limit · resets 10:50pm (Asia/Dubai)" and no tokens. The runner's usage-limit pattern did not match that wording, and a run whose calls failed was still saved as complete: **10 runs were saved as complete but were not** (9 with zero tokens: procinfo all-sonnet and all-opus, both Firecracker clean cases in all three arms, the Next.js clean case for tierview; plus procinfo tierview, whose Opus call failed after Sonnet ran). On the clean cases this would have counted as "no false positives". Mohamed reported the limit when it had reset.

Valid results of this batch:

| case | tierview | all-sonnet | all-opus |
|---|---|---|---|
| dpdk-hws-counter-double-free (buggy) | (batch 2: caught) | (batch 2: caught) | **caught** (1 call, $0.124) |
| dpdk-mem-fbarray-placement (buggy, wide) | 1 finding, not a match (2, $0.579) | no findings (1, $0.217) | no findings (1, $0.541) |

Fixes (no `claude` calls; tests added; 243 pass):
1. `LIMIT_ERROR` also matches "hit your … limit", "limit · resets", "session limit", "weekly limit".
2. A run with any errored call (`CALL_ERROR`: "call failed … : error: …"; refusals and parse failures are outcomes, not errors) is incomplete, and the batch stops there, whether or not the error text is recognised.
3. A failed judge call now always stops the batch (the findings stay pending).
4. A scan of every saved run (runs/ and runs-archive/) found failed calls only in this batch. The 10 runs are marked incomplete (`stopped: "call error (usage limit), found after test batch 3; re-run"`), so the runner archives and re-runs them. Their usage lines stay in `usage.jsonl` as recorded (calls made, zero tokens).

The runner is not part of the config hash (it decides which runs count, not how a run is measured), so `bench-config-v2` / `4fe1abf9f1f3` stands.

Test split so far: 30 of 60 runs valid (26 from batches 1 and 2, 4 from batch 3). 30 runs left, about 42 to 60 calls: 3 batches.

---

*Template for each later phase:*

**Model.** …
**Effort.** …
**Prompt.** … (verbatim, or the kickoff prompt from PLAN §13 plus any follow-ups)
**Delivered.** …
**Deviations from the plan, and why.** …
**Issues.** …
**API spend this phase.** …
