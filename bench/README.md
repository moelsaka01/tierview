# Benchmark

Empty until Phase 4. The design is in [PLAN.md §9](../PLAN.md).

- `cases/` — one JSON file per case (bug-introducing commit, fix commit, faulty lines).
- `results/` — `results.json`, `RESULTS.md`, `chart.svg`, `spend.json` (the spend ledger).
- `repos/` — local clones, not committed.

The benchmark has a hard spend cap (default $25). The pilot on 10 cases runs first, and the full run needs explicit approval.
