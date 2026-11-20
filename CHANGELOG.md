# Changelog

## 0.1.1 (2026-11-20)

- New risk signal `resilience_limits` (weight 25): changed timeouts, deadlines, TTLs, retry limits and backoff values now raise a hunk to Tier 2. These pass tests and fail under load. It is not part of the benchmarked config (`bench-config-v2`), so the published benchmark numbers were measured without it.
- `resilience_limits`: `ttl` now matches only as a name or name segment (`ttl`, `cacheTtl`, `ttlMs`, `session_ttl`); the first version also fired on words like `settled`, `little` and `throttle`.
- The signal was checked against the benchmark's dev split with no model calls: it matches no changed line in any of the 30 benchmark diffs, so the benchmark can neither support nor reject it. Weight 25 is kept as a stated judgement. Default config frozen as `bench-config-v3` (git tag, config hash `087925df358a`).

## 0.1.0 (2026-11-17)

First release.

- `tierview review`: Tier 0 risk scoring, three model tiers with confidence-based escalation, merge and ranking, cost receipt with an all-Fable counterfactual. `--dry-run` makes zero model calls.
- Backends: `claude-code` (default, runs on a Claude plan through the official `claude` CLI, no API key) and `api` (your own `ANTHROPIC_API_KEY`; unit-tested with a mocked SDK only).
- Fable 5.2 is opt-in on the `claude-code` backend (`--allow-fable`).
- `tierview pr <url>`, `--json`, `--sarif`, `--fail-on`, `--max-cost`, `--max-calls`, `tierview models`.
- GitHub Action with a PR summary comment (tested with mocked GitHub responses only, not yet live).
- Benchmark on 30 real commits (13 buggy and 7 clean on the held-out test split): tierview caught 9 of 13 bugs vs 7 for all-Opus and 4 for all-Sonnet, with 0 false alarms on 7 clean cases, at 16% lower cost per case than all-Opus. Not statistically significant (exact McNemar p = 0.5). See `bench/results/RESULTS.md`.
