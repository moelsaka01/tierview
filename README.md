# tierview

**Tiered Claude code review with a cost receipt.**

AI code review that sends each hunk of a diff to the cheapest Claude model that can handle it, escalates when a model is unsure, and prints a cost receipt. On a 13-bug test set it caught more bugs than all-Opus (9 vs 7, not significant: p = 0.5) with zero false alarms, at 16% lower cost per case. Details, ranges and limits: [bench/results/RESULTS.md](bench/results/RESULTS.md).

**Status: under construction.** `tierview review` works on a local diff, and the first benchmark is done (30 cases, small; read its limits). The design and the task list are in [PLAN.md](PLAN.md); the record of how it is being built is in [BUILD_LOG.md](BUILD_LOG.md).

This README will be written in Phase 6, after the benchmark has run, so that every number in it is measured.

## Development

```bash
npm install
npm run check
```

MIT licensed. Runs on your Claude plan through the official Claude Code CLI (default), or on the API with your own Anthropic API key (`--backend api`).

## Fable 5.2 is opt-in on the Claude Code backend

On some Claude plans Fable 5.2 uses paid extra usage, and `claude -p` does not ask before using it. So on the default `claude-code` backend tierview never requests Fable unless you opt in:

```bash
tierview review --allow-fable
```

or set `allowFable: true` in `.tierview.yml`. With opt-in, tierview prints a warning before the first call. Without it, Tier 3 runs on Opus 5.5 at high effort, and the receipt says `Tier 3 ran on Opus 5.5 (Fable not enabled)`. The receipt's all-Fable comparison is still shown: it is a calculation from token counts and list prices, not a call. `tierview models --probe` skips Fable unless you pass `--allow-fable`. The `api` backend bills your own API key and is not affected.
