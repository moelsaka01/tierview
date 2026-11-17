# Configuration

tierview reads `.tierview.yml` from the current directory (or `--config <file>`) and merges it over [`config/default-rules.yml`](../config/default-rules.yml), which is the source of truth for every default. Objects merge key by key; arrays and scalars you give replace the default. Unknown signal names and invalid regexes are errors (exit 2).

```yaml
version: 1
ignore: ["docs/**"]
rules:
  - { paths: ["src/billing/**"], min_tier: 3 }
  - { paths: ["scripts/**"], max_tier: 1 }
signals:
  churn: { enabled: false }
  auth: { weight: 45 }
thresholds: { tier2: 25, tier3: 60 }
allowFable: false
budget: { max_cost_usd: 1.00 }
```

## Keys

| key | default | meaning |
|---|---|---|
| `version` | `1` | must be `1` |
| `models.tier1/2/3` | Sonnet 5.5 low / Opus 5.5 medium / Fable 5.2 high | model and effort per tier (`low`, `medium`, `high`, `xhigh`, `max`). Model IDs are in the file |
| `thresholds` | `tier2: 25, tier3: 60` | risk score below `tier2` goes to Tier 1, below `tier3` to Tier 2, otherwise Tier 3 |
| `escalation.tier1_min_confidence` | `0.7` | a Tier 1 hunk below this confidence goes up (rule E1) |
| `escalation.tier2_min_confidence` | `0.6` | same for Tier 2 |
| `escalation.tier1_verify_severity` | `high` | a Tier 1 finding at or above this is confirmed or refuted by a higher tier (E3) |
| `escalation.tier2_verify_severity` | `critical` | same for Tier 2 |
| `escalation.max_rate` | `0.3` | if more of a tier's hunks escalate than this, the receipt prints a calibration warning |
| `budget.max_cost_usd` | `null` | hard cap per run (API-equivalent on `claude-code`); `--max-cost` overrides |
| `tier1_context` | `tier3` | `tier3`: Tier 1 gets the same file context as Tier 3; `none`: only the diff's own 3 lines |
| `allowFable` | `false` | opt in to Fable 5.2 on the `claude-code` backend (may use paid extra usage on some plans) |
| `receipt.baseline` | Fable 5.2 high | the model the receipt's "all-Fable" comparison is priced at |
| `backend.default` | `claude-code` | `claude-code` or `api` |
| `backend.claude_code.*` | see file | `binary`, `max_hunks_per_call` (40), `max_tokens_per_call` (40000), `timeout_s` (900) |
| `backend.api.*` | see file | `max_tokens` (16000), `concurrency` (4) |
| `ignore` | `[]` | globs of files that are never reviewed (tier 0) |
| `rules` | `[]` | per-path overrides, applied in order after scoring: `paths` plus any of `min_tier`, `max_tier`, `add` (extra score) |
| `file_kinds` | see file | globs for `generated` (never sent to a model), `docs`, `test`, `config`; everything else is `source` |
| `signals` | none | override one signal: a category (`auth.weight`) or a structure signal (`churn.enabled`) |
| `structure`, `reductions` | see file | structure points and reductions, below |

## How the score works

Score = sum over categories of the largest matching weight in that category, plus structure points, minus reductions, clamped to 0 to 100. Taking the largest per category stops an `auth/` path and a `jwt` keyword from counting twice. `tierview review --dry-run` prints every contribution for every hunk.

## Category signals

Patterns are JavaScript regexes, matched case-insensitively against the file path (`path`), added and removed lines (`content`), added lines only (`content_added`) or removed lines only (`content_removed`). `logic` entries are code in `src/tier0/signals.ts`.

| signal | weight | fires on |
|---|---:|---|
| `secrets` | 40 | `.env*` and credentials paths; key, token and private-key literals; `password = "..."` |
| `auth` | 35 | auth, login, session, oauth, jwt, sso, password paths and keywords |
| `crypto` | 35 | cipher, hmac, tls and key paths; md5, sha1, ECB, disabled TLS verification, `Math.random()`, nonce or salt assignments |
| `payment` | 35 | payment, billing, invoice, refund paths and keywords; money-suffixed amounts being changed |
| `sql` | 30 | SQL built by interpolation or concatenation, `execute(`, `raw(`; `.sql` files; `drop`/`truncate`/`alter table` |
| `migrations` | 30 | `migrations/`, `alembic/`, `prisma/migrations/`, schema files |
| `deserialization` | 30 | `pickle`, `yaml.load`, `unserialize`, `ObjectInputStream`, `eval`, `new Function` |
| `unsafe` | 30 | `unsafe`, `memcpy`/`strcpy`, `shell=True`, `child_process`, `innerHTML`, `malloc`/`free` |
| `tests_weakened` | 30 | added skip or ignore markers; a deleted test file or test function |
| `permissions` | 25 | role and permission checks, `chmod`, `sudo`, CORS, ACLs |
| `concurrency` | 25 | locks, atomics, threads, goroutines, channels; `await` added or removed |
| `boundary` | 25 | a comparison operator or index arithmetic changed; a rewritten `if`/`while`/`for` condition; a new bounds check |
| `memory` | 25 | allocation, free and lifetime calls (`kmalloc`, `g_free`, `*_unref(`, `Box::into_raw`, ...) |
| `error_handling_removed` | 20 | removed `try`/`catch`/`except`, `if err != nil`, asserts or validation; added empty catch, `.unwrap()`, `@ts-ignore` |
| `infra` | 20 | Dockerfile, CI workflows, Terraform, Kubernetes, Helm |
| `assertions_removed` | 20 | a test hunk whose assertion count drops |
| `dependencies` | 15 | `package.json`, `requirements*.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile` |

## Structure signals (`structure`)

| signal | default points | fires when |
|---|---:|---|
| `size` | 0 / 5 / 10 / 15 | the hunk changes up to 5 / 30 / 100 / more lines |
| `scatter` | 10 | the diff touches more than 8 files or more than 3 top-level directories |
| `many_hunks_in_file` | 5 | a file has more than 5 hunks in the diff |
| `churn` | 10 | the file has 10 or more commits in 90 days (needs local git history) |
| `hotspot` | 10 | the file has 2 or more fix-like commits in 90 days (needs local git history) |
| `deletion_only` | 5 | the hunk only deletes lines |
| `diff_weakens_tests` | 10 | `tests_weakened` fired anywhere in the diff (on every source hunk) |
| `no_tests_changed` | 5 | more than 50 source lines changed and no test file |

`reductions`: a test file with no test signal gets -15; docs files and comment-, whitespace- or import-only hunks are capped at a score of 5. Churn and hotspot need a local checkout with history: with a shallow clone, with `--diff-file`, or in PR mode, they contribute 0 and the receipt says so.

## Escalation

A hunk moves up a tier when its confidence is below the tier's minimum (E1), when the model sets `needs_escalation` (E2), when it reports a finding at or above the verify severity (E3), when its answer contradicts itself (E4) or when the call fails or skips the hunk (E5). Higher tiers run once, with their own hunks and every escalated hunk together. When Tiers 2 and 3 run the same model (Fable off), they run as one tier at the higher effort.

## Exit codes

0 clean, 1 findings at or above `--fail-on`, 2 usage or config error, 3 budget exhausted (something was left unreviewed; the receipt lists it).
