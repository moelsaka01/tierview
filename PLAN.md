# tierview — build plan

> Fable-level code review at Sonnet prices. *(Tagline is provisional: it ships only if the benchmark in §9 supports it. See §12.)*

tierview is an open-source CLI and GitHub Action that reviews a diff by routing each hunk to the cheapest Claude model that can handle it, escalating when a model is unsure, and printing a cost receipt. It runs on your Claude plan through the official Claude Code CLI (the default `claude-code` backend), or on the API with your own Anthropic API key (the `api` backend, for teams and the GitHub Action). See §5a.

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
  llm/backend.ts      ReviewBackend interface, request/result types (§5a)
  llm/client.ts       `api` backend; the only file that imports the Anthropic SDK
  llm/claude-code.ts  `claude-code` backend: runs the official `claude` CLI (§5a)
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

Rules for every phase: pure functions for scoring, routing, escalation, merge and cost so they test without the network; the backend is injected as an interface (`ReviewBackend`) so tests use a fake (`test/fake-client.ts`); no test may call the real API or run the real `claude` binary.

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

**Refusals and failures**: `stop_reason: "refusal"`, a null `parsed_output`, or a missing `hunk_id` in the response → one retry for parse failures only, then escalate the affected hunks (Tier 1, Tier 2) or mark them `not_reviewed` with the reason (Tier 3). Cost is always computed from the `model` field of the response. **Decided in Phase 3:** the server-side fallback beta is *not* enabled. Escalation already re-sends a refused hunk to the next tier's model, and a server-side switch mid-request would blur which model's output and price a finding carries (see BUILD_LOG Phase 3).

## 5a. Backends (added in Phase 3)

A `ReviewBackend` (`src/llm/backend.ts`) takes one request (tier, model, effort, system prompt, shared context, hunks) and returns a parsed `TierResponse` or a failure, with usage per model. `--backend` or `backend.default` in config picks one.

**`claude-code` (default).** Runs the official Claude Code CLI non-interactively, one process per request. Flags checked against `claude --help` (v2.1.322) and code.claude.com/docs (cli-reference, headless, model-config, agent-sdk/cost-tracking) on 2026-11-16:

```
claude -p --output-format json --json-schema <TierResponse> --model <id> --effort <level> --tools ""
       --system-prompt-file <tmp> --no-session-persistence --disable-slash-commands --strict-mcp-config
       --safe-mode [--fallback-model <tier-2 model>]          # hunks on stdin
```

- The result JSON carries `structured_output` (absent when the run failed or declined), `usage`, `modelUsage` (per model: input, output, cache read, cache creation incl. `cacheCreationEphemeral1hInputTokens`, `costUSD`), `total_cost_usd`, `is_error`, `subtype`. Claude Code writes cache with a 1-hour TTL on a plan, so API-equivalent cost prices those tokens at `cache_write_1h`.
- Each call costs about 2,100 tokens of Claude Code overhead (its structured-output tool and a second turn) on top of tierview's prompt (`claude_code_overhead_tokens_per_call` in `config/estimates.json`). So all tiers **batch across files** up to `backend.claude_code.max_hunks_per_call` (40) and `max_tokens_per_call` (40k), concurrency 1, to keep calls few.
- Safety: the process runs in an empty temp directory with `--safe-mode`, so the reviewed repo's CLAUDE.md, hooks, MCP servers and plugins never load (`-p` skips the trust dialog). tierview resolves the binary (`TIERVIEW_CLAUDE_BIN`, config `backend.claude_code.binary`, PATH, then `~/.local/bin`), checks that `claude --version` says "(Claude Code)", and only executes it. It never reads, copies or reuses Claude Code's credentials.
- **Fable is opt-in (changed before Phase 4).** On the `claude-code` backend tierview never requests Fable unless the user passes `--allow-fable` or sets `allowFable: true` in `.tierview.yml` (default `false`). Without opt-in, every tier configured as Fable runs on the Tier 2 model (Opus 5.5) at its own effort, with no Fable-first request and no Fable `--fallback-model`; the receipt says "Tier 3 ran on Opus 5.5 (Fable not enabled)" and `--dry-run` says it will. The backend itself refuses to start a `claude` process for a Fable model without opt-in, and `tierview models --probe` skips Fable. With opt-in, tierview prints a warning on stderr before the first call that Fable may use paid extra usage on some plans. The receipt's all-Fable baseline (`receipt.baseline`) is unchanged: it is a calculation, not a call. The `api` backend is not affected. Code: `src/fable.ts`.
- **Tier 2 and Tier 3 merge when they run the same model (Phase 4, Mohamed's change).** With Fable off both are Opus 5.5, and two Opus calls (medium, then high) pay Claude Code's per-call overhead twice. So Tier 2 hunks join Tier 3, which runs at the higher of the two efforts (high), Tier 1 escalates straight to it, and a budget degrade moves Tier 3 hunks straight to Tier 1. Code: `src/tiers/collapse.ts`; `--dry-run` notes it.
- **Model detection.** Tier 3 calls pass `--fallback-model <tier-2 model>`. The model that actually ran is read from `modelUsage`. If it is not the requested one (or the requested model errors), the run uses the fallback for the rest of Tier 3, lists it in `receipt.model_substitutions`, and caches the result for 7 days in `~/.tierview/claude-code-models.json`. `tierview models` shows the cache; `tierview models --probe` checks each tier model with one tiny call. Caveat from the docs: when a plan bills Fable to usage credits, `claude -p` bills without asking; hence the opt-in above, and the receipt warns when Fable ran.
- Receipt: tokens per tier and **API-equivalent cost** (`cost_basis: "api_equivalent"`): the tokens priced at `config/prices.json`, not what the plan bills.
- Limits: `--max-calls <n>` is a hard cap on model calls per run; hunks left over are `not_reviewed: budget` (a blocked escalation keeps the lower tier's review and adds a note). `--max-cost` still works, on the API-equivalent figure.

**`api`.** The Anthropic SDK with `ANTHROPIC_API_KEY` (§0 request shape, §5). For teams and the GitHub Action. Unit-tested with a mocked SDK only; never run live in Phase 3 (no key).

## 6. Escalation and confidence

Each model returns, per hunk, `verdict`, `confidence` (0–1) and `needs_escalation`. A hunk moves **Tier 1 → Tier 2** when any of these holds:

- E1 `confidence < 0.7`
- E2 `needs_escalation` is true
- E3 any finding with severity `high` or `critical` (a stronger model confirms or refutes it: cheap, and it cuts false positives)
- E4 contradiction, checked deterministically: (a) `verdict: "clean"` with findings, or `"issues"` with none; (b) a finding cites a file or line range outside the hunk it was reported for; (c) two findings on overlapping lines whose severities differ by ≥ 2 levels
- E5 failure: refusal, schema failure after one retry, or the hunk missing from the response

**Tier 2 → Tier 3** uses the same rules with `confidence < 0.6` for E1 and `critical` only for E3. Tier 3 never escalates; its low-confidence findings are kept and labelled.

**Whole-diff escalation (Phase 4, Mohamed's change).** Every Tier 1 batch runs first. Then each higher tier runs **once**, with its own routed hunks and every hunk escalated into it in the same calls, packed as §5a allows (on `claude-code` that is one call for a typical diff; on `api`, Tiers 2 and 3 still send one request per file). With Tiers 2 and 3 merged this is one Sonnet round and one Opus round. Before, each escalation round was a separate call.

Guard: if more than `max_rate` (30%) of a tier's hunks escalate, finish the run but print a calibration warning in the receipt.

Self-reported confidence is known to be poorly calibrated. The thresholds above are starting values; Phase 4 measures calibration on the dev split (§9) and tunes them from saved outputs without new API calls.

## 7. Budget cap, merge, receipt

**`--max-cost`** is a hard cap enforced by `budget.ts`:

1. Plan: estimate the run (as `--dry-run` does). If it exceeds the cap, degrade before any call: move the lowest-scoring Tier 3 hunks to Tier 2, then the lowest-scoring Tier 2 hunks to Tier 1, then drop the lowest-scoring Tier 1 hunks as `not_reviewed`, until the plan fits with a 15% reserve for escalations.
2. Run: before each request, reserve its worst case (`estimated input × input price + max_tokens × output price`). If `spent + reserved > cap`, do not send; mark the hunks `not_reviewed: budget`. After each response, settle with actual usage.
3. Order (changed in Phase 4): Tier 1, then Tier 2 with escalations, then Tier 3 with escalations (§6). Priority still goes to risk: before Tier 1 runs, the calls (`--max-calls`) and worst-case cost (`--max-cost`) of the higher tiers' own hunks are held back, and likewise Tier 3's while Tier 2 runs; within a tier, packs of routed hunks go before packs of only escalated hunks. So a cap cuts low-risk hunks and escalations first.
4. Exit code 3 when anything was dropped for budget. The receipt lists every degraded or dropped hunk.

**Exit codes**: 0 clean; 1 findings at or above `--fail-on <severity>` (default: never fail); 2 usage or config error; 3 budget exhausted.

**Merge** (`merge.ts`): two findings are duplicates when they share file and category, their line ranges overlap within ±3 lines, and the token Jaccard similarity of `title + explanation` is ≥ 0.5. Keep the highest tier's version and record the others in `also_reported_by`. Findings listed in a higher tier's `refuted_prior` are removed from the review and kept under `refuted` in JSON output. Rank by severity, then confidence, then tier. Every finding carries `model` and `tier`.

**Receipt** (schema in §8): per tier, hunks routed, hunks escalated in, requests, token classes, cost; then total, skipped and not-reviewed counts, and the all-Fable figure. **Costs are shown two ways on `claude-code`** (Phase 4, Mohamed's change): **via Claude Code** (the tokens that ran, at list prices: API-equivalent) and **direct API** (the same tokens without Claude Code's ~2,100-token per-call overhead, `claude_code_overhead_tokens_per_call` in `config/estimates.json`, the remaining input-side tokens at the uncached input rate). On `api` the two are equal. **The all-Fable figure is computed one way only, everywhere** (receipt, dry run, benchmark; Phase 4, Mohamed's change): **this run's actual tokens priced at the baseline model's rates** (`receipt.baseline`, Fable 5.2), on both cost bases; the dry run uses its own estimated tokens. It is a calculation: a real all-Fable run would send different tokens (every hunk with Tier 3 context), so it understates that cost, and the savings figure is a price ratio for the same work. Code: `src/costs.ts`. The baseline model is independent of the Tier 3 model, so the comparison survives a Tier 3 override or fallback.

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
Receipt = { "backend": "claude-code" | "api",
            "cost_basis": "api_equivalent" | "billed",      // api_equivalent on claude-code (§5a)
            "calls": int,                                    // model calls, retries included
            "model_substitutions": { "tier": 1|2|3, "requested": string, "used": string, "reason": string }[],
            "tiers": { "tier": 1|2|3, "model": string, "effort": string, "hunks": int, "escalated_in": int,
                       "requests": int, "input_tokens": int, "cache_write_tokens": int,
                       "cache_read_tokens": int, "output_tokens": int, "cache_write_1h_tokens": int,
                       "cost_usd": number /* via Claude Code on claude-code */, "direct_api_cost_usd": number }[],
            "skipped_hunks": int, "not_reviewed_hunks": int, "total_cost_usd": number, "total_direct_api_cost_usd": number,
            "baseline": { "model": string /* config receipt.baseline */, "method": "actual_tokens_at_baseline_prices",
                          "cost_usd": number, "direct_api_cost_usd": number },
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

**Clean cases**: commits from the same repos (in Phase 4: from 2025-08 to 2025-11, so that 12 months of later history exist), size-matched, that have no later `Fixes:` / revert / "regression" reference and whose lines were not touched by any fix-labelled commit for ≥ 12 months. These are *presumed* clean; the write-up says so.

**Backend** (changed in Phase 3): the whole benchmark, judge included, runs on the **`claude-code` backend** on Mohamed's Claude Pro plan. There is no API key and no dollar budget. The constraint is the plan's usage limits, so the benchmark runs **in batches across days** and records usage for every run (see Usage control).

**Size**: about **30 cases: 20 buggy + 10 clean**, at least 4 languages (from C, Python, TypeScript/JavaScript, Go, Rust, Java), no repo over 20% of cases. **Split**: 10 cases are the dev split (includes the 5 pilot cases); the other 20 are the test split. Thresholds and prompts may be tuned only on dev. Before the full run, commit the frozen config and record its hash in the results. With about 14 buggy test cases the confidence intervals are wide; the write-up reports them and makes no claim the intervals do not support.

**Contamination**: models may have seen these fixes in training. Record `F`'s date, prefer fixes after mid-2026, and report results separately for the post-cutoff subset. The comparison between arms is relative, which limits the damage, and the write-up says this plainly.

**Arms** (same prompts and schema throughout):

| Arm | What runs |
|---|---|
| `tierview` | the real pipeline with the frozen config; Fable not enabled, so Tier 3 runs on Opus 5.5 `high` (§5a) |
| `all-sonnet` | every hunk → Sonnet 5.5 `low`, Tier 3 request shape |
| `all-opus` | every hunk → Opus 5.5 `medium`, Tier 3 request shape |
| `all-fable` | **not run** (no Fable calls, see below). Reported as a calculated cost only. |

Baselines share the Tier 3 context builder so the only variable is model and effort. No escalation in baselines. On `claude-code` each baseline sends all of a case's hunks in as few calls as the §5a batch limits allow.

**No Fable calls (decided at the start of Phase 4).** Mohamed has no budget for extra usage, and on some plans Fable draws on paid extra usage that `claude -p` bills without asking. So the benchmark makes **zero Fable calls**: the `all-fable` arm is not run, the planned `all-fable-low` arm is dropped (it was the strongest simple alternative to a cascade, but it needs Fable calls, so the question it answers stays open and the write-up says so), and `tierview` runs without `--allow-fable`, i.e. Tier 3 on Opus 5.5 at high effort. The all-Fable cost is **calculated one way** (§7, changed in Phase 4): actual tokens priced at Fable 5.2 rates. The headline figure is the `all-opus` arm's tokens at Fable rates (every hunk to the top model with the Tier 3 request shape, which is what an all-Fable run would send; Fable's real token counts would differ); every arm's own tokens at Fable rates are listed too. The earlier receipt estimator and its error metric are gone. The tagline check in §12 compares against `all-opus` and says so.

**Scoring**:
- A buggy case is **caught** when at least one finding describes the bug. **Judge (changed in Phase 4, Mohamed's decision): rules first, Opus only when the rules cannot decide.** Each finding of a buggy case is matched against the case's faulty lines (lines of `B` that `F` rewrote, in `B`'s numbering): **match** when it is on the new side of a faulty file and its line range is within ±3 lines of a faulty line; **no match** when it is in another file, or more than 10 lines from every faulty line and outside every faulty hunk; **ambiguous** otherwise (inside a faulty hunk or within 4–10 lines of a faulty line, or on the old side of a faulty hunk). Only ambiguous findings go to the model judge: the Tier 2 model (Opus 5.5) at `medium` on the `claude-code` backend, one call per (case, arm) with all of that run's ambiguous findings, given the fix diff, the bug description and the findings, blind to the arm. Every judgement, rule or model, is logged to `bench/results/judgements.jsonl` with its reason. 20 random judgements (both kinds) are audited by hand and the agreement rate is published (`bench/results/judge-audit.md`). Judge calls count toward the batch cap.
- **False positives** are measured on clean cases only: findings of severity ≥ medium per case, and the share of clean cases with at least one. Unmatched findings on buggy cases are reported as "unmatched", not as false positives (they may be real).
- **Routing recall** (free, no API): share of faulty hunks that Tier 0 routed to Tier 2 or 3. Bugs missed *because* they were routed low are reported separately. This is the failure mode a reader will ask about.

**Metrics table**: recall with bootstrap 95% CI; paired McNemar test of tierview against all-opus; false positives per clean case; mean **tokens and cost per case and per bug caught, via Claude Code and direct API** (§7); claude calls per case; latency p50 / p90 (wall time of the `claude` calls, which includes CLI start-up, so it is not API latency, and the write-up says so); escalation rate; calculated all-Fable cost per case (actual tokens at Fable rates, both cost bases, labelled as calculated). Runs of an older arm version (`ARM_VERSION` in `bench/arms.ts`; tierview v2 = merged tiers and whole-diff escalation) are stale: the runner re-runs them and archives the old file in `bench/results/runs-archive/`, and metrics lists them as their own row (`tierview@v1`). A judgement counts only for the run it judged (`run_batch`).

**Outputs**: `bench/results/results.json`, `bench/results/RESULTS.md` (table + method + limits), `bench/results/chart.svg` (cost per case on x, recall on y, one point per arm with CI bars; hand-written SVG, readable in light and dark).

**Usage control** (`bench/run.ts`), replacing the old $25 spend cap:
- **Record usage per run.** Every (case, arm) run and every judge call appends one line to `bench/results/usage.jsonl`: timestamp, batch id, case, arm, claude calls, tokens per model (input, cache write, cache read, output), API-equivalent cost, wall time, model substitutions. `bench/results/usage.md` sums it per batch, per arm and overall. No dollar budget applies.
- **Batches.** A batch is one sitting, capped by `--max-calls`: **at most 20 `claude` calls per batch** (Mohamed's limit; judge calls count). The runner never starts a (case, arm) run that could cross the cap, stops at the first rate-limit or usage-limit error, and exits cleanly. After each batch, stop and report usage; the next batch starts in a later session when the plan's usage has reset. Runs are resumable: finished (case, arm) pairs are cached on disk and never re-run, so the next batch, often the next day, continues where the last stopped.
- Mohamed starts each batch. A batch never starts on its own.

**Order of work**: (1) build the 30-case dataset and **show Mohamed the case list** before any `claude` call; (2) pilot on 5 cases (3 buggy, 2 clean), all three arms, in batches of ≤ 20 calls; (3) report measured calls, tokens and API-equivalent cost per case and arm, and a projection for 30 cases as a number of batches; (4) **stop and ask Mohamed** before the full run. Tier 0 routing recall needs no calls and can be measured as soon as the dataset exists.

Planning estimate, to be replaced by the pilot's numbers: tierview 2–4 calls per case, each baseline 1, the Opus judge about 1 per (buggy case, arm) with an ambiguous finding, often none, so roughly 5–8 calls per case with three arms, about 150–220 calls for 30 cases, or 8–11 batches of 20. Treat this as a guess until measured.

## 10. Outputs and integrations (Phase 5)

- `tierview pr <url>`: fetch the PR diff with Octokit (`GITHUB_TOKEN`, `Accept: application/vnd.github.diff`), title and body for shared context. Without a checkout, Tier 3 file context comes from the contents API at the PR head sha, and churn signals are off.
- `--sarif <file>`, `--json`, `--comment` (one summary comment containing the ranked findings and the receipt; updates its previous comment instead of adding a new one).
- GitHub Action: `action.yml` (`runs.using: node24`, verify the current runtime name when you get there), entry `src/action.ts` bundled to `dist/` with tsup. Inputs: `anthropic-api-key`, `max-cost`, `fail-on`, `config`. The Action always uses `--backend api` (no Claude Code login on a runner). Recommend `fetch-depth: 0` so churn signals work.

## 11. Phased task list

Every task ends with `npm run check` (typecheck + tests) passing. Tick the box in this file when done.

### Phase 1 — Fable 5.2 — plan and scaffold (done)
- [x] P1-01 Competitor check, model and price lookup (§0, §1)
- [x] P1-02 `PLAN.md`
- [x] P1-03 Scaffold, `BUILD_LOG.md`, first commit

### Phase 2 — Sonnet 5.5 — Tier 0, config, dry-run. Read §2–§4, §7 (dry-run paragraph), §8.
- [x] P2-01 `src/tier0/diff.ts` + `test/diff.test.ts` + fixtures `test/fixtures/*.diff`: parse unified diffs into `Hunk[]`. Covers multi-file, multi-hunk, new, deleted, renamed, binary, "no newline at end of file".
- [x] P2-02 `src/git.ts` + `test/git.test.ts`: `getDiff({base, head, staged})` via `git diff --no-color -U3 -M`; `fileChurn(paths, days)` from a single `git log` call; returns zeros on a shallow clone. Test against a temp repo.
- [x] P2-03 `src/config.ts`, `src/prices.ts` + tests: load and validate `.tierview.yml` over `config/default-rules.yml`; `costOf(usage, model)` per the §0 formula; unknown model → clear error.
- [x] P2-04 `src/tier0/signals.ts` + `test/signals.test.ts`: file kind, every category in §4, structure signals. Table-driven tests, at least one positive and one negative per category.
- [x] P2-05 `src/tier0/score.ts`, `src/tier0/route.ts` + tests: max-per-category sum, caps, thresholds, `ignore` and `rules`. The five worked examples in §4 are tests.
- [x] P2-06 `src/estimate.ts` + test: token estimate, per-tier cost plan, all-Fable baseline estimate, using `config/estimates.json`.
- [x] P2-07 `src/cli.ts`, `src/output/terminal.ts`: `tierview review [--base --head --staged] --dry-run [--json]` prints the routing table with reasons and the estimate. Without `--dry-run`, exit 2 with "LLM tiers arrive in Phase 3".
- [x] P2-08 Snapshot test of dry-run output on a fixture diff; update `BUILD_LOG.md`; commit.

### Phase 3 — Opus 5.5 — LLM tiers, escalation, receipt, backends. Read §0, §5–§8.
- [x] P3-01 `src/llm/backend.ts` (`ReviewBackend` interface) + `src/llm/client.ts` `api` backend (`messages.parse`, effort, cache marker, refusal check, usage capture, typed-error handling) unit-tested with a mocked SDK + `src/llm/claude-code.ts` `claude-code` backend (§5a: official binary only, structured output, model detection and fallback, detection cache) tested with a fake runner. `test/fake-client.ts` for the rest.
- [x] P3-02 `src/llm/prompts.ts` + test: one system prompt per tier, byte-stable shared context (test: two builds are identical).
- [x] P3-03 `src/tiers/batch.ts` + test: Tier 1 packing limits; per-file grouping for Tiers 2 and 3 on `api`; cross-file batches for every tier on `claude-code`. The estimator now uses this packer.
- [x] P3-04 `src/tiers/context.ts` + test: ±30 lines; whole file ≤ 400 lines; ±80 lines plus enclosing function otherwise.
- [x] P3-05 `src/tiers/escalate.ts` + test: rules E1–E5 for both steps, one test per rule.
- [x] P3-06 `src/budget.ts` + test: degrade plan, reserve / settle, never exceeds the cap in a simulated run.
- [x] P3-07 `src/merge.ts` + test: dedupe, refutation, ranking.
- [x] P3-08 `src/receipt.ts`, `src/output/json.ts`, receipt rendering in `src/output/terminal.ts` + tests. Tokens per tier; API-equivalent cost and the all-Fable comparison on `claude-code`.
- [x] P3-09 `src/pipeline.ts` + test with the fake client: full run including an escalation chain and a budget stop. Wire into `src/cli.ts` (`--backend`, `--max-cost`, `--max-calls`, `--json`, `--fail-on`, `--include-untracked`, `--diff-file`) and `tierview models [--probe]`.
- [x] P3-10 Live smoke test on the `claude-code` backend, small diffs only, at most 5 `claude` calls (`test/fixtures/seeded-bug*.diff`). No API key, so no live `api` call. Calibrate `config/estimates.json` from the measured usage, log it in `BUILD_LOG.md`; commit.

### Phase 4 — Opus 5.5 — benchmark. Read §9, §8.
- [x] P4-01 `bench/mine.ts`: collect candidate (B, F) pairs from the §9 sources into `bench/candidates.jsonl`.
- [x] P4-02 `bench/validate.ts` + test: blame check and filters; write `bench/cases/<id>.json`; clean-case selection.
- [x] P4-03 Manual pass; `bench/cases/README.md` lists every case with its source link and the dev / test split.
- [x] P4-04 `bench/arms.ts`: the three arms (`tierview`, `all-sonnet`, `all-opus`) as config presets over the real pipeline on the `claude-code` backend; no Fable arm (§9).
- [x] P4-05 `bench/run.ts` + test: resumable runner in batches (≤ 20 calls per batch, stop on a usage-limit error), usage ledger `bench/results/usage.jsonl` per run (§9 Usage control).
- [x] P4-06 `bench/judge.ts` + test: rule-based match first, Opus only for ambiguous findings, every judgement logged, audit sample export.
- [x] P4-07 `bench/metrics.ts` + test: every metric in §9, bootstrap CI, McNemar.
- [x] P4-08 Pilot on 5 cases in batches of ≤ 20 calls, no Fable. Report measured calls, tokens and API-equivalent cost, and the projection in batches. **Stop and ask Mohamed.**
- [ ] P4-09 Tune risk weights and thresholds on the dev split from saved outputs and Tier 0 routing recall (includes the "payment" false positive on `estimate.ts`, Phase 2 issue); commit the frozen config.
- [ ] P4-10 Full run on the test split in batches across days, each started by Mohamed; judge audit.
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

- **The tagline is a claim.** If tierview's recall on the test split is clearly below all-opus's, or its cost is nearer Opus than Sonnet, change the tagline to what the numbers say. With no measured Fable arm (§9), the tagline cannot say "Fable-level". Publishing an honest "87% of the recall at 24% of the cost" is better for this repo's audience than an unsupported slogan.
- **A single strong model at low effort may beat the cascade.** The planned `all-fable-low` arm was dropped (no Fable calls, §9), so this stays untested; `all-sonnet` is the only single-model low-effort arm. The write-up says so.
- **Routing misses.** A bug in a boring-looking hunk goes to Sonnet at low effort. Routing recall (§9) quantifies this; escalation rules E1–E3 are the mitigation.
- **Confidence calibration** may be too weak to drive escalation. If so, fall back to E2–E5 only and say so.
- **Benchmark size.** About 14 buggy test cases (30 cases in all, run on a Pro plan) gives very wide confidence intervals. Report the intervals, not just the point estimates, and treat the result as a pilot-scale comparison, not proof.
- **Fable is not measured.** No Fable calls in Phase 4 (§9); the all-Fable number is calculated. The tagline cannot claim "Fable-level" without a measured Fable arm.
- **Prices change.** `config/prices.json` carries `as_of`; the receipt prints it.

## 13. Kickoff prompts

Paste one of these into a fresh chat opened in this folder.

- **Phase 2**: "Read PLAN.md §0–§4, the dry-run paragraph of §7, and §8. Do tasks P2-01 to P2-08 in order. Tick each box, run `npm run check` after each task, add a Phase 2 entry to BUILD_LOG.md, commit, and stop."
- **Phase 3**: "Read PLAN.md §0 and §5–§8, then `src/types.ts`. Do P3-01 to P3-10 in order. Ask me before any real API call. Tick boxes, log in BUILD_LOG.md, commit, and stop."
- **Phase 4**: "Read PLAN.md §5a, §8 and §9. Do P4-01 to P4-08, then stop and report the pilot usage and the projection in batches. No Fable calls; at most 20 `claude` calls per batch; ask me before every batch."
- **Phase 5**: "Read PLAN.md §8 and §10. Do P5-01 to P5-07. Tick boxes, log in BUILD_LOG.md, commit, and stop."
- **Phase 6**: "Read PLAN.md §1, §12 and bench/results/RESULTS.md. Do P6-01 to P6-05. Every number in the README must come from RESULTS.md."
