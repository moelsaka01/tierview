# tierview

AI code review that sends each hunk of a diff to the cheapest Claude model that can handle it, escalates when a model is unsure, and prints a cost receipt.

**Status: under construction.** Nothing here reviews code yet. The design and the task list are in [PLAN.md](PLAN.md); the record of how it is being built is in [BUILD_LOG.md](BUILD_LOG.md).

This README will be written in Phase 6, after the benchmark has run, so that every number in it is measured.

## Development

```bash
npm install
npm run check
```

MIT licensed. Bring your own Anthropic API key.
