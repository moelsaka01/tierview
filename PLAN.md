# tierview — build plan

> Fable-level code review at Sonnet prices. *(Tagline is provisional: it ships only if the benchmark in §9 supports it. See §12.)*

tierview is an open-source CLI and GitHub Action that reviews a diff by routing each hunk to the cheapest Claude model that can handle it, escalating when a model is unsure, and printing a cost receipt. Bring your own Anthropic API key.

**How to use this file.** Each phase runs in a fresh chat. Read §0–§3 (short), then only the sections your phase lists in §11. Do not re-read sections you don't need. Log your work in `BUILD_LOG.md` when you finish.

---

## 0. Facts checked on 2026-11-16 (do not re-research)

Source: <https://platform.claude.com/docs/en/about-claude/pricing> and the Claude API reference. Prices are USD per million tokens and live in `config/prices.json`, the only place prices may appear in code.

| Tier | Model ID | Effort | Input | Cache write (5m) | Cache read | Output | Batch in / out |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | `claude-sonnet-5-5` | `low` | 2.00 | 2.50 | 0.10 | 10.00 | 1.00 / 5.00 |
| 2 | `claude-opus-5-5` | `medium` | 4.00 | 5.00 | 0.20 | 20.00 | 2.00 / 10.00 |
| 3 | `claude-fable-5-2` | `high` | 8.00 | 10.00 | 0.20 | 40.00 | 4.00 / 20.00 |

API rules that shape the design (all three models):

- **Effort** is `output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }`. Always set it explicitly: the default differs per model (Opus 5.5 defaults to `medium`, the other two to `high`).
- **Thinking** is adaptive and on by default. Omit the `thinking` parameter. `{type: "disabled"}` and `budget_tokens` return a 400. Thinking tokens are billed as output tokens and are included in `usage.output_tokens`.
- **Forced tool choice is rejected** (`tool_choice` `any` / `tool` → 400). Get JSON with structured outputs: `client.messages.parse({ ..., output_config: { effort, format: zodOutputFormat(Schema) } })`, import `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`, read `response.parsed_output` (null if parsing failed). Structured-output schemas cannot express numeric ranges or string lengths, so validate those client-side.
- **No `temperature` / `top_p` / `top_k`** (400). No assistant prefill.
- **Prompt caching** is a prefix match, scoped per model, so each tier warms its own cache. Minimum cacheable prefix: 512 tokens on all three models. A shorter prefix silently does not cache. Verify with `usage.cache_read_input_tokens`.
- **Refusals**: a safety classifier can return HTTP 200 with `stop_reason: "refusal"`. Security-related diffs make this plausible. Always check `stop_reason` before reading content.
- **Batch API** gives 50% off input and output, results within 24h, no latency measurement. Used only by the benchmark (§9).
- **Fable 5.2** needs 30-day data retention on the org (zero-retention orgs get a 400). The Tier 3 model must therefore be configurable.
- Cost of one response = `input_tokens × input + cache_creation_input_tokens × cache_write + cache_read_input_tokens × cache_read + output_tokens × output`, each divided by 1e6.

## 1. Competitor check (two searches and two page reads, not a code audit)

1. **Tiered routing alone is not new.** d1ff (MIT) routes each change to a simple / medium / complex model tier, and OrcaCode Review screens with a cheap model before a strong final pass. Do not claim "first tiered reviewer".
2. **Qodo** (commercial; PR-Agent is the Apache-2.0 core, now community-maintained) routes review *depth per PR* with a small LLM classifier. tierview routes *per hunk* with deterministic, inspectable rules, so routing costs nothing and `--dry-run` can explain every decision.
3. **CodeRabbit, Greptile, Ellipsis** are closed and priced per seat, so there is no per-review cost to show. **Kodus** (AGPL, bring-your-own-key) lets you pick a model per task, with no escalation.
4. What I did not find anywhere: confidence-based escalation between tiers, and a **cost receipt with a counterfactual** ("this review cost $0.04; all-Fable would have cost about $0.31").
5. What I did not find anywhere in open source: a **published ground-truth benchmark** of the router against single-model baselines. d1ff has a `benchmark/` directory but shows no results. The receipt and the benchmark are the differentiators; lead with them.

## 2. Language: TypeScript (Node ≥ 22)

- A JavaScript GitHub Action starts in about a second with no Docker pull; a Python action needs a container or a setup step on every run.
- `npx tierview` gives zero-install use, which matters for stars.
- The official SDK (`@anthropic-ai/sdk`) has first-class zod structured outputs, and the later hosted GitHub App (Octokit / Probot) is TypeScript-native, so one codebase serves CLI, Action and App.
- Cost of this choice: charts are less convenient than matplotlib. The benchmark chart is a hand-written SVG (no dependency, renders in a GitHub README).

Runtime deps: `@anthropic-ai/sdk`, `zod`, `commander`, `yaml`, `picomatch`. Phase 5 adds `octokit`. Dev: `typescript`, `vitest`, `tsup`. Keep the list this short.

## 3. Architecture

```
diff source ──► Tier 0 (no LLM) ──► router ──► Tier 1 Sonnet/low ──┐
(git | PR URL)  parse, score        │          Tier 2 Opus/medium ─┼─► merge ──► output
                                    │          Tier 3 Fable/high ──┘   dedupe      terminal | JSON | SARIF | PR comment
                                    └─ dry-run stops here              rank        + cost receipt
                       escalation: T1 ──► T2 ──► T3 (rules in §6)
                       budget ledger wraps every API call (§7)
```

```
src/
  cli.ts              commander entry: review | pr | --dry-run | --max-cost | --json | --sarif
  types.ts            zod schemas + TS types (§8). The contract between modules.
  config.ts           load .tierview.yml over config/default-rules.yml
  prices.ts           load config/prices.json; costOf(usage, model)
  git.ts              getDiff(), fileChurn()
  estimate.ts         token + cost estimates for dry-run and the baseline
  budget.ts           reserve / settle ledger, degrade plan
  pipeline.ts         orchestrates a run
  merge.ts            dedupe + rank
  receipt.ts          build the Receipt
  tier0/diff.ts       unified diff → Hunk[]
  tier0/signals.ts    deterministic signals
  tier0/score.ts      signals → score + reasons
  tier0/route.ts      score + rules → tier
  llm/client.ts       the only file that imports the Anthropic SDK
  llm/prompts.ts      system prompts, shared-context builder
  tiers/batch.ts      pack hunks into requests
  tiers/context.ts    surrounding file context
  tiers/escalate.ts   escalation decisions (pure)
  output/terminal.ts  output/json.ts  output/sarif.ts
  github/pr.ts        github/comment.ts        (Phase 5)
  action.ts           GitHub Action entry      (Phase 5)
config/prices.json  config/default-rules.yml  config/estimates.json
bench/              benchmark (Phase 4, §9)
test/               vitest; fixtures in test/fixtures/
```

Rules for every phase: pure functions for scoring, routing, escalation, merge and cost so they test without the network; `llm/client.ts` is injected as an interface so tests use a fake; no test may call the real API.

## 4. Tier 0: parsing and risk score

`Hunk.id` is `"<path>#<n>"` (n = 1-based hunk index in that file). Types are in `src/types.ts`.

**File kind** (first match): `generated` (lockfiles, `dist/`, `vendor/`, `*.min.*`, snapshots, `*.pb.go`, etc.) → tier 0, never sent to a model, listed in the receipt as skipped; `docs`; `test`; `config`; `source`.

**Score** = clamp(0, 100, Σ over categories of the *largest* matching weight in that category + structure points − reductions). Taking the max per category stops `auth/` path + `jwt` keyword from double counting. Every contribution is recorded in `reasons[]` so `--dry-run` can print why. Patterns and weights are data in `config/default-rules.yml` (source of truth); this table is the summary.

| Category | Fires on (path = file path, content = added or removed lines) | Weight |
|---|---|---:|
| secrets | content: key/token literal patterns, `password =` assignments; path: `.env*`, `*credentials*` | 40 |
| auth | path or content: auth, login, session, oauth, jwt, sso, password, token verification | 35 |
| crypto | path or content: cipher, hmac, sign/verify, tls/ssl, cert; weak primitives (md5, sha1, ECB, `verify=False`, `rejectUnauthorized: false`) | 35 |
| payment | path or content: payment, billing, invoice, checkout, ledger, refund, stripe | 35 |
| sql | content: raw SQL built by concatenation / interpolation, `execute(`, `raw(`; path: `*.sql` | 30 |
| migrations | path: `migrations/`, `alembic/`, `prisma/migrations/`, schema files | 30 |
| deserialization | content: `pickle`, `yaml.load`, `unserialize`, `ObjectInputStream`, `eval`, `new Function` | 30 |
| unsafe | content: `unsafe`, `memcpy`/`strcpy`, `shell=True`, `child_process.exec`, `dangerouslySetInnerHTML` | 30 |
| tests-weakened | deleted test file or test function; added skip marker (`it.skip`, `xit`, `@skip`, `t.Skip`, `#[ignore]`, `@Disabled`) or `.only` | 30 |
| permissions | content: role / permission / admin checks, `chmod`, `sudo`, CORS, ACL | 25 |
| concurrency | content: lock, mutex, atomic, thread, goroutine, channel, `synchronized`, async/await added or removed | 25 |
| error-handling-removed | removed `try`/`catch`/`except`, removed `if err != nil`, added empty catch, removed validation or assert | 20 |
| infra | path: Dockerfile, `.github/workflows/`, terraform, k8s, helm | 20 |
| assertions-removed | test hunk whose assertion count drops | 20 |
| dependencies | path: `package.json`, `requirements*.txt`, `go.mod`, `Cargo.toml`, `pom.xml` | 15 |
| boundary | a comparison operator or index arithmetic changed on a modified line | 10 |

Structure points (added to the category sum):

| Signal | Points |
|---|---:|
| Hunk size (added + deleted lines): ≤5 / 6–30 / 31–100 / >100 | 0 / 5 / 10 / 15 |
| Scatter: diff touches >8 files, or >3 top-level directories | +10 (each source hunk) |
| File has >5 hunks in this diff | +5 |
| Churn: file has ≥10 commits in the last 90 days | +10 |
| Hotspot: file has ≥2 commits matching `/\bfix(es|ed)?\b|bug|regress/i` in the last 90 days | +10 |
| Deletion-only hunk | +5 |
| Diff weakens tests anywhere (tests-weakened fired) | +10 on every *source* hunk |
| Diff changes >50 source lines and no test file | +5 on every source hunk |

Reductions and caps: test file with no test signal −15; `docs` file, or a hunk that is only comments / whitespace / import reordering → score capped at 5. Churn needs local git history; with a shallow clone or in PR mode without a checkout, churn and hotspot contribute 0 and the receipt says so.

**Routing thresholds** (configurable): score < 30 → Tier 1; 30–59 → Tier 2; ≥ 60 → Tier 3. Then apply `.tierview.yml` rules in order: `ignore` globs (tier 0), then `rules[]` entries with `paths` plus any of `min_tier`, `max_tier`, `add`.

Worked examples (use as tests): `src/auth/login.py`, 12 changed lines, f-string SQL → auth 35 + sql 30 + size 5 = 70 → Tier 3. `src/auth/session.ts`, 8 lines, nothing else → 35 + 5 = 40 → Tier 2. `src/utils/format.ts`, 20 lines → 5 → Tier 1. `README.md` → capped at 5 → Tier 1. `package-lock.json` → generated → skipped.

`.tierview.yml` shape:

```yaml
version: 1
models:
  tier1: { model: claude-sonnet-5-5, effort: low }
  tier2: { model: claude-opus-5-5,   effort: medium }
  tier3: { model: claude-fable-5-2,  effort: high }
thresholds: { tier2: 30, tier3: 60 }
escalation: { tier1_min_confidence: 0.7, tier2_min_confidence: 0.6, max_rate: 0.3 }
budget: { max_cost_usd: null }
ignore: ["docs/**"]
rules:
  - { paths: ["src/billing/**"], min_tier: 3 }
  - { paths: ["scripts/**"], max_tier: 1 }
signals: { churn: { enabled: false }, auth: { weight: 45 } }
```

## 5. LLM tiers

**Request shape** (all tiers): `system` = [tier system prompt, shared context ← `cache_control: {type: "ephemeral"}` on this last block]; one `user` message with the hunks for this request; `output_config: { effort, format: zodOutputFormat(TierResponse) }`; `max_tokens: 16000`; no `thinking`, no sampling params.

**Shared context** (identical bytes for every request of a tier, built once): PR title and description if any, the changed-file list with +/− counts, and a hunk map (id, tier, score). No timestamps, no random ids, stable ordering.

**Caching rule**: add the `cache_control` marker only when the tier will send ≥ 2 requests and the prefix is estimated ≥ 512 tokens (a write costs 1.25× input; a lone request would pay that for nothing). Send the tier's first request, await it, then fan out the rest (concurrency 4) so they read the cache instead of all writing it.

| | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| Unit of one request | batch of hunks across files, a file's hunks kept together, ≤ 12 hunks and ≤ 6k estimated tokens | all of a file's Tier 2 hunks | all of a file's Tier 3 hunks |
| Context beyond the hunk | none (the diff's own 3 context lines) | ±30 lines around each hunk | whole file if ≤ 400 lines, else ±80 lines and the enclosing function |
| Prior findings included | — | Tier 1's, for escalated hunks | Tier 1's and Tier 2's |

The prompt for a tier that receives prior findings says: verify or refute each one, and list refuted ids in `refuted_prior`.

**Refusals and failures**: `stop_reason: "refusal"`, a null `parsed_output`, or a missing `hunk_id` in the response → one retry for parse failures only, then escalate the affected hunks (Tier 1, Tier 2) or mark them `not_reviewed` with the reason (Tier 3). Cost is always computed from the `model` field of the response. Phase 3 decides whether to also enable the server-side fallback beta (`server-side-fallback-2026-07-01`, `fallbacks: "default"`); read the claude-api skill's refusal section first and record the decision in `BUILD_LOG.md`.

## 6. Escalation and confidence

Each model returns, per hunk, `verdict`, `confidence` (0–1) and `needs_escalation`. A hunk moves **Tier 1 → Tier 2** when any of these holds:

- E1 `confidence < 0.7`
- E2 `needs_escalation` is true
- E3 any finding with severity `high` or `critical` (a stronger model confirms or refutes it: cheap, and it cuts false positives)
- E4 contradiction, checked deterministically: (a) `verdict: "clean"` with findings, or `"issues"` with none; (b) a finding cites a file or line range outside the hunk it was reported for; (c) two findings on overlapping lines whose severities differ by ≥ 2 levels
- E5 failure: refusal, schema failure after one retry, or the hunk missing from the response

**Tier 2 → Tier 3** uses the same rules with `confidence < 0.6` for E1 and `critical` only for E3. Tier 3 never escalates; its low-confidence findings are kept and labelled.

Guard: if more than `max_rate` (30%) of a tier's hunks escalate, finish the run but print a calibration warning in the receipt.

Self-reported confidence is known to be poorly calibrated. The thresholds above are starting values; Phase 4 measures calibration on the dev split (§9) and tunes them from saved outputs without new API calls.

## 7. Budget cap, merge, receipt

**`--max-cost`** is a hard cap enforced by `budget.ts`:

1. Plan: estimate the run (as `--dry-run` does). If it exceeds the cap, degrade before any call: move the lowest-scoring Tier 3 hunks to Tier 2, then the lowest-scoring Tier 2 hunks to Tier 1, then drop the lowest-scoring Tier 1 hunks as `not_reviewed`, until the plan fits with a 15% reserve for escalations.
2. Run: before each request, reserve its worst case (`estimated input × input price + max_tokens × output price`). If `spent + reserved > cap`, do not send; mark the hunks `not_reviewed: budget`. After each response, settle with actual usage.
3. Tier 3 runs first, then Tier 2, then Tier 1, then escalations, so the money goes to the riskiest hunks first.
4. Exit code 3 when anything was dropped for budget. The receipt lists every degraded or dropped hunk.

**Exit codes**: 0 clean; 1 findings at or above `--fail-on <severity>` (default: never fail); 2 usage or config error; 3 budget exhausted.

**Merge** (`merge.ts`): two findings are duplicates when they share file and category, their line ranges overlap within ±3 lines, and the token Jaccard similarity of `title + explanation` is ≥ 0.5. Keep the highest tier's version and record the others in `also_reported_by`. Findings listed in a higher tier's `refuted_prior` are removed from the review and kept under `refuted` in JSON output. Rank by severity, then confidence, then tier. Every finding carries `model` and `tier`.

**Receipt** (schema in §8): per tier, hunks routed, hunks escalated in, requests, token classes, cost; then total, skipped and not-reviewed counts, and the all-Fable baseline. The baseline is an **estimate** and is labelled as one: every non-skipped hunk priced as a Tier 3 request (same context builder), with output tokens per hunk taken from this run's Tier 3 usage when it reviewed ≥ 3 hunks, otherwise from `config/estimates.json`. The benchmark measures the true all-Fable cost and reports how far this estimator is off.

**`--dry-run`** makes zero API calls: Tier 0, routing table with reasons, estimated cost per tier, estimated baseline. Token estimate is `ceil(chars / 3.0)` (constant in `config/estimates.json`, calibrated in P3-10).

## 8. JSON schemas (implemented in `src/types.ts`)

Model output, per request:

```jsonc
TierResponse = { "reviews": HunkReview[] }
HunkReview = {
  "hunk_id": "src/auth/login.py#2",
  "verdict": "clean" | "issues" | "unsure",
  "confidence": 0.0-1.0,            // validated and clamped client-side
  "needs_escalation": boolean,
  "escalation_reason": string,       // "" when not escalating
  "refuted_prior": string[],         // finding ids from a lower tier
  "findings": ModelFinding[]
}
ModelFinding = {
  "file": string, "start_line": int, "end_line": int,
  "side": "new" | "old",             // "old" for a problem on a deleted line
  "severity": "critical" | "high" | "medium" | "low" | "info",
  "category": "bug" | "security" | "concurrency" | "data-loss" | "performance"
            | "api-contract" | "error-handling" | "test" | "maintainability",
  "title": string,                   // ≤ 80 chars, checked client-side
  "explanation": string, "suggestion": string,   // "" when none
  "evidence": string,                // the offending line, quoted
  "confidence": 0.0-1.0
}
```

Final output (`--json`):

```jsonc
Review = { "version": 1, "findings": Finding[], "refuted": Finding[],
           "not_reviewed": { "hunk_id": string, "reason": string }[],
           "routing": { "hunk_id", "score", "tier", "reasons": { "signal", "weight", "detail" }[] }[],
           "receipt": Receipt }
Finding = ModelFinding & { "id": string,          // sha1(file|start|end|category|normalized title).slice(0,12)
           "hunk_id": string, "model": string, "tier": 1|2|3,
           "escalated_from": (1|2)[], "also_reported_by": string[] }
Receipt = { "tiers": { "tier": 1|2|3, "model": string, "effort": string, "hunks": int, "escalated_in": int,
                       "requests": int, "input_tokens": int, "cache_write_tokens": int,
                       "cache_read_tokens": int, "output_tokens": int, "cost_usd": number }[],
            "skipped_hunks": int, "not_reviewed_hunks": int, "total_cost_usd": number,
            "baseline": { "model": "claude-fable-5-2", "method": "estimated", "cost_usd": number },
            "savings_pct": number, "budget": { "max_cost_usd": number|null, "degraded": boolean },
            "warnings": string[], "wall_ms": int, "prices_as_of": string }
```

SARIF 2.1.0 mapping (Phase 5): one `run`, `tool.driver.name = "tierview"`, `ruleId = category`, `level` = error (critical, high) / warning (medium) / note (low, info), `properties` = { model, tier, confidence }.

## 9. Benchmark design (Phase 4)

The project's credibility rests on this, so the design favours claims that survive scrutiny over large numbers.

**Case** = one bug-introducing commit `B` in a public repo plus the later fix commit `F`. The reviewer sees only the diff of `B` (`B^..B`), at the repo state of `B`.

**Data sources, in order of preference** (ground truth attested by maintainers, not guessed):
1. Fix commits carrying a `Fixes: <sha>` trailer (Linux, git, QEMU, systemd, DPDK and others use it).
2. Fix commits or PRs that name their cause: "regression from #123", "introduced in <sha>", `git revert` commits with a stated reason.
3. Published bug-introducing datasets (candidates to verify before use: Defectors, ApacheJIT, InferredBugs). Plain SZZ output without a maintainer link is not accepted.

**Automatic validation** of every candidate (`bench/validate.ts`): `B` and `F` both exist; at least one line removed or changed by `F` is attributed to `B` by `git blame` at `F^`; `B` changes ≤ 400 lines and ≤ 15 files; `F` changes ≤ 60 lines (a small fix localises the bug); not a merge commit. Then a manual pass: read `F`'s message and drop cases where the "bug" is a feature change or a build fix. Record: repo, shas, language, the faulty lines (lines of `B` that `F` touched), a one-sentence bug description from `F`'s message, `F`'s date.

**Clean cases**: commits from the same repos and months, size-matched, that have no later `Fixes:` / revert / "regression" reference and whose lines were not touched by any fix-labelled commit for ≥ 12 months. These are *presumed* clean; the write-up says so.

**Size**: target 60 buggy + 30 clean, at least 5 languages (C, Python, TypeScript/JavaScript, Go, Rust, Java), no repo over 20% of cases. The final size is set by the pilot's cost projection: the largest set up to 100 buggy cases that projects under 85% of the cap. **Split**: 20 cases are the dev split (includes the 10 pilot cases); the rest are the test split. Thresholds and prompts may be tuned only on dev. Before the full run, commit the frozen config and record its hash in the results.

**Contamination**: models may have seen these fixes in training. Record `F`'s date, prefer fixes after mid-2026, and report results separately for the post-cutoff subset. The comparison between arms is relative, which limits the damage, and the write-up says this plainly.

**Arms** (same prompts and schema throughout):

| Arm | What runs |
|---|---|
| `tierview` | the real pipeline with the frozen config |
| `all-sonnet` | every hunk → Sonnet 5.5 `low`, Tier 3 request shape |
| `all-opus` | every hunk → Opus 5.5 `medium`, Tier 3 request shape |
| `all-fable` | every hunk → Fable 5.2 `high`, Tier 3 request shape |
| `all-fable-low` | every hunk → Fable 5.2 `low`. The strongest simple alternative to a cascade; if it wins, say so. |

Baselines share the Tier 3 context builder so the only variable is model and effort. No escalation in baselines.

**Scoring**:
- A buggy case is **caught** when at least one finding (a) is in a file `F` touched and within ±10 lines of a faulty line or in the same function, and (b) is judged to describe the same defect. The judge is `claude-sonnet-5-5` at `medium`, given the fix diff, the bug description and the finding, blind to the arm. 20 random judge decisions are audited by hand and the agreement rate is published (`bench/results/judge-audit.md`).
- **False positives** are measured on clean cases only: findings of severity ≥ medium per case, and the share of clean cases with at least one. Unmatched findings on buggy cases are reported as "unmatched", not as false positives (they may be real).
- **Routing recall** (free, no API): share of faulty hunks that Tier 0 routed to Tier 2 or 3. Bugs missed *because* they were routed low are reported separately. This is the failure mode a reader will ask about.

**Metrics table**: recall with bootstrap 95% CI; paired McNemar test of tierview against all-fable; false positives per clean case; mean cost per case and cost per bug caught; latency p50 / p90; escalation rate; receipt-estimator error against measured all-fable cost.

**Outputs**: `bench/results/results.json`, `bench/results/RESULTS.md` (table + method + limits), `bench/results/chart.svg` (cost per case on x, recall on y, one point per arm with CI bars; hand-written SVG, readable in light and dark).

**Spend control** (`bench/run.ts`): a persistent ledger `bench/results/spend.json` counts every dollar ever spent by the benchmark, including the pilot and the judge. Cap `--max-spend`, default **$25**. Before each request, reserve its worst case; refuse to send if the ledger would pass the cap. Runs are resumable: finished (case, arm) pairs are cached on disk and never re-billed.

**Order of work**: (1) pilot on 10 cases (7 buggy, 3 clean), all arms, synchronous so latency is real; (2) report measured cost per arm and a projection for the full set, with and without the Batch API for baselines; (3) **stop and ask Mohamed** before the full run. With the Batch API, baseline latency comes from the pilot only (n = 10) and the write-up says so.

Planning estimate, to be replaced by the pilot's numbers: all-fable ≈ $0.20 per case synchronous, so 90 cases × 5 arms does not fit in $25 synchronously and should fit with batched baselines (≈ $19). Treat this as a guess until measured.

## 10. Outputs and integrations (Phase 5)

- `tierview pr <url>`: fetch the PR diff with Octokit (`GITHUB_TOKEN`, `Accept: application/vnd.github.diff`), title and body for shared context. Without a checkout, Tier 3 file context comes from the contents API at the PR head sha, and churn signals are off.
- `--sarif <file>`, `--json`, `--comment` (one summary comment containing the ranked findings and the receipt; updates its previous comment instead of adding a new one).
- GitHub Action: `action.yml` (`runs.using: node24`, verify the current runtime name when you get there), entry `src/action.ts` bundled to `dist/` with tsup. Inputs: `anthropic-api-key`, `max-cost`, `fail-on`, `config`. Recommend `fetch-depth: 0` so churn signals work.

## 11. Phased task list

Every task ends with `npm run check` (typecheck + tests) passing. Tick the box in this file when done.

### Phase 1 — Fable 5.2 — plan and scaffold (done)
- [x] P1-01 Competitor check, model and price lookup (§0, §1)
- [x] P1-02 `PLAN.md`
- [x] P1-03 Scaffold, `BUILD_LOG.md`, first commit

### Phase 2 — Sonnet 5.5 — Tier 0, config, dry-run. Read §2–§4, §7 (dry-run paragraph), §8.
- [ ] P2-01 `src/tier0/diff.ts` + `test/diff.test.ts` + fixtures `test/fixtures/*.diff`: parse unified diffs into `Hunk[]`. Covers multi-file, multi-hunk, new, deleted, renamed, binary, "no newline at end of file".
- [ ] P2-02 `src/git.ts` + `test/git.test.ts`: `getDiff({base, head, staged})` via `git diff --no-color -U3 -M`; `fileChurn(paths, days)` from a single `git log` call; returns zeros on a shallow clone. Test against a temp repo.
- [ ] P2-03 `src/config.ts`, `src/prices.ts` + tests: load and validate `.tierview.yml` over `config/default-rules.yml`; `costOf(usage, model)` per the §0 formula; unknown model → clear error.
- [ ] P2-04 `src/tier0/signals.ts` + `test/signals.test.ts`: file kind, every category in §4, structure signals. Table-driven tests, at least one positive and one negative per category.
- [ ] P2-05 `src/tier0/score.ts`, `src/tier0/route.ts` + tests: max-per-category sum, caps, thresholds, `ignore` and `rules`. The five worked examples in §4 are tests.
- [ ] P2-06 `src/estimate.ts` + test: token estimate, per-tier cost plan, all-Fable baseline estimate, using `config/estimates.json`.
- [ ] P2-07 `src/cli.ts`, `src/output/terminal.ts`: `tierview review [--base --head --staged] --dry-run [--json]` prints the routing table with reasons and the estimate. Without `--dry-run`, exit 2 with "LLM tiers arrive in Phase 3".
- [ ] P2-08 Snapshot test of dry-run output on a fixture diff; update `BUILD_LOG.md`; commit.

### Phase 3 — Opus 5.5 — LLM tiers, escalation, receipt. Read §0, §5–§8.
- [ ] P3-01 `src/llm/client.ts`: `ReviewClient` interface + Anthropic implementation (`messages.parse`, effort, cache marker, refusal check, usage capture, typed-error retry). `test/fake-client.ts` for tests.
- [ ] P3-02 `src/llm/prompts.ts` + test: one system prompt per tier, byte-stable shared context (test: two builds are identical).
- [ ] P3-03 `src/tiers/batch.ts` + test: Tier 1 packing limits; per-file grouping for Tiers 2 and 3.
- [ ] P3-04 `src/tiers/context.ts` + test: ±30 lines; whole file ≤ 400 lines; ±80 lines plus enclosing function otherwise.
- [ ] P3-05 `src/tiers/escalate.ts` + test: rules E1–E5 for both steps, one test per rule.
- [ ] P3-06 `src/budget.ts` + test: degrade plan, reserve / settle, never exceeds the cap in a simulated run.
- [ ] P3-07 `src/merge.ts` + test: dedupe, refutation, ranking.
- [ ] P3-08 `src/receipt.ts`, `src/output/json.ts`, receipt rendering in `src/output/terminal.ts` + tests.
- [ ] P3-09 `src/pipeline.ts` + test with the fake client: full run including an escalation chain and a budget stop. Wire into `src/cli.ts` (`--max-cost`, `--json`, `--fail-on`).
- [ ] P3-10 Live smoke test on `test/fixtures/seeded-bug.diff` with `--max-cost 0.50`. **Ask Mohamed before the first real API call.** Confirm `cache_read_input_tokens > 0` on a multi-request tier, calibrate `config/estimates.json`, log actual cost in `BUILD_LOG.md`; commit.

### Phase 4 — Opus 5.5 — benchmark. Read §9, §8.
- [ ] P4-01 `bench/mine.ts`: collect candidate (B, F) pairs from the §9 sources into `bench/candidates.jsonl`.
- [ ] P4-02 `bench/validate.ts` + test: blame check and filters; write `bench/cases/<id>.json`; clean-case selection.
- [ ] P4-03 Manual pass; `bench/cases/README.md` lists every case with its source link and the dev / test split.
- [ ] P4-04 `bench/arms.ts`: the five arms as config presets over the real pipeline.
- [ ] P4-05 `bench/run.ts` + test: resumable runner, spend ledger with hard cap, optional Batch API for baselines.
- [ ] P4-06 `bench/judge.ts` + test: location pre-filter, blind judge, audit sample export.
- [ ] P4-07 `bench/metrics.ts` + test: every metric in §9, bootstrap CI, McNemar.
- [ ] P4-08 Pilot on 10 cases. Report measured cost and projection. **Stop and ask Mohamed.**
- [ ] P4-09 Tune thresholds on the dev split from saved outputs; commit the frozen config.
- [ ] P4-10 Full run on the test split within the cap; judge audit.
- [ ] P4-11 `bench/chart.ts` → `chart.svg`; `bench/results/RESULTS.md`; update `BUILD_LOG.md`; commit.

### Phase 5 — Sonnet 5.5 — PR mode, SARIF, Action. Read §10, §8.
- [ ] P5-01 `src/github/pr.ts` + test (mocked HTTP): parse PR URL, fetch diff, title, body, head sha.
- [ ] P5-02 `tierview pr <url>` in `src/cli.ts`; file context through the contents API.
- [ ] P5-03 `src/output/sarif.ts` + test validating against the SARIF 2.1.0 schema.
- [ ] P5-04 `src/github/comment.ts` + test: create-or-update summary comment.
- [ ] P5-05 `src/action.ts`, `action.yml`, tsup bundle to `dist/`.
- [ ] P5-06 `.github/workflows/ci.yml` (typecheck, test) and `examples/tierview.yml` (usage workflow).
- [ ] P5-07 End-to-end dry-run against one public PR; update `BUILD_LOG.md`; commit.

### Phase 6 — Sonnet 5.5 — README and release. Read §1, §12, `bench/results/RESULTS.md`.
- [ ] P6-01 `README.md` in the style of the honest-* repos (read one of their READMEs once): what it does, a real receipt, the benchmark table and chart, limits stated plainly.
- [ ] P6-02 `docs/CONFIG.md`: every `.tierview.yml` key and every signal.
- [ ] P6-03 `package.json` publish metadata, `npm pack` contents check, `CHANGELOG.md`, tag `v0.1.0`.
- [ ] P6-04 `docs/HOSTED.md`: one page on the later hosted GitHub App (what stays open, what is paid).
- [ ] P6-05 Final pass on `BUILD_LOG.md`; commit.

## 12. Risks and open decisions

- **The tagline is a claim.** If tierview's recall on the test split is clearly below all-fable's, or its cost is nearer Opus than Sonnet, change the tagline to what the numbers say. Publishing an honest "87% of the recall at 24% of the cost" is better for this repo's audience than an unsupported slogan.
- **`all-fable-low` may beat the cascade.** One model at low effort is simpler and shares one cache. If it wins, the project's value becomes the receipt, the budget cap and the benchmark, and the default config should change.
- **Routing misses.** A bug in a boring-looking hunk goes to Sonnet at low effort. Routing recall (§9) quantifies this; escalation rules E1–E3 are the mitigation.
- **Confidence calibration** may be too weak to drive escalation. If so, fall back to E2–E5 only and say so.
- **Benchmark size.** Around 45 buggy test cases gives wide confidence intervals. Report the intervals, not just the point estimates.
- **Prices change.** `config/prices.json` carries `as_of`; the receipt prints it.

## 13. Kickoff prompts

Paste one of these into a fresh chat opened in this folder.

- **Phase 2**: "Read PLAN.md §0–§4, the dry-run paragraph of §7, and §8. Do tasks P2-01 to P2-08 in order. Tick each box, run `npm run check` after each task, add a Phase 2 entry to BUILD_LOG.md, commit, and stop."
- **Phase 3**: "Read PLAN.md §0 and §5–§8, then `src/types.ts`. Do P3-01 to P3-10 in order. Ask me before any real API call. Tick boxes, log in BUILD_LOG.md, commit, and stop."
- **Phase 4**: "Read PLAN.md §8 and §9. Do P4-01 to P4-08, then stop and report the pilot cost and projection. Never exceed the spend cap."
- **Phase 5**: "Read PLAN.md §8 and §10. Do P5-01 to P5-07. Tick boxes, log in BUILD_LOG.md, commit, and stop."
- **Phase 6**: "Read PLAN.md §1, §12 and bench/results/RESULTS.md. Do P6-01 to P6-05. Every number in the README must come from RESULTS.md."
