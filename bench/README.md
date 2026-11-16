# Benchmark

The design is in [PLAN.md §9](../PLAN.md). About 30 cases (20 bug-introducing commits with a maintainer-attested fix, 10 presumed-clean commits), three arms (`tierview`, `all-sonnet`, `all-opus`; no Fable calls), a rule-first judge, run on the `claude-code` backend in batches of at most 20 `claude` calls.

- `sources.json` — where candidate pairs come from (repos, search terms, fix dates).
- `mine.ts` → `candidates.jsonl` — fix commits whose message names the commit that introduced the bug (`Fixes: <sha>`, "Regression in <sha>", "regression from #PR").
- `validate.ts` → `validated.jsonl`, `clean.jsonl`, `cases/` — size limits, `git blame` check that the fix rewrote lines of the bug commit, clean-commit selection, case files.
- `cases/` — one `<id>.json` (metadata, fix, faulty lines) and `<id>.diff` (the diff the reviewer sees) per case; `cases/README.md` lists them with the dev / test split.
- `results/` — **`RESULTS.md` (the write-up)**, `chart.svg`, `results-test.json` / `results-dev.json`, `judge-audit.csv` (20 judgements for a hand audit), `usage.jsonl` (one line per run and per judge call), `batches.jsonl`, `judgements.jsonl`, `runs/`, `runs-archive/`.
- `repos/` — local blobless clones, not committed.

```bash
npm run bench:mine                               # GitHub commit search (read-only)
npm run bench:validate -- validate 10 qemu/qemu  # per repo, resumable
node .bench-build/validate.js clean django/django Python 2025-08-01 2025-11-15 3
node .bench-build/validate.js make bench/selection.json
```

## Running a batch (at most 20 `claude` calls; Mohamed starts each one)

```bash
npm run bench:build
node .bench-build/run.js --cases pilot --dry-run   # what the next batch would run, zero calls
node .bench-build/run.js --cases pilot             # one batch: stops at 20 calls or a usage-limit error
node .bench-build/metrics.js --split dev           # tables from saved runs, zero calls
```

The judge is rule-based first (finding within ±3 lines of a faulty line = match); only ambiguous findings go to Opus 5.5, one call per (case, arm). Every judgement is in `results/judgements.jsonl`, every call's usage in `results/usage.jsonl`.
