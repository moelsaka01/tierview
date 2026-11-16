# Build log

One entry per phase: which model did the work, at what effort, from what prompt, and what went wrong or changed. Each phase runs in a fresh chat; the plan is [PLAN.md](PLAN.md).

| Phase | Scope | Planned model | Status |
|---|---|---|---|
| 1 | Plan and scaffold | Fable 5.2 | done 2026-11-16 |
| 2 | Tier 0, config, dry-run | Sonnet 5.5 | done 2026-11-16 |
| 3 | LLM tiers, escalation, receipt | Opus 5.5 | not started |
| 4 | Benchmark | Opus 5.5 | not started |
| 5 | PR mode, SARIF, GitHub Action | Sonnet 5.5 | not started |
| 6 | README and release | Sonnet 5.5 | not started |

---

## Phase 1 — plan and scaffold (2026-11-16)

**Model.** The chat started on Sonnet 5.5 (`claude-sonnet-5-5`) by mistake. Sonnet did the lookups: two web searches and two page reads for the competitor check, and the pricing page. The session was then switched to Fable 5.2 (`claude-fable-5-2`), which wrote `PLAN.md`, the scaffold and this log.

**Effort.** Session default. The app does not show the effort level to the model, so it is not recorded here. *(Mohamed: fill in if you set one.)*

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

## Phase 2 — Tier 0, config, dry-run

*Template for each later phase:*

**Model.** …
**Effort.** …
**Prompt.** … (verbatim, or the kickoff prompt from PLAN §13 plus any follow-ups)
**Delivered.** …
**Deviations from the plan, and why.** …
**Issues.** …
**API spend this phase.** …
