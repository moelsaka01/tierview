# Working rules for this repo

- `PLAN.md` is the spec. Read §0–§3, then only the sections your phase names in §11. Do not re-read the whole file or files you have not been asked to change.
- Do the tasks of one phase, in order. Tick each box in `PLAN.md` as it passes `npm run check`.
- When the phase is done, add an entry to `BUILD_LOG.md` (model, effort, prompt, issues, any deviation from the plan and why), commit, and stop.
- Prices appear only in `config/prices.json`. Model IDs appear only in `config/default-rules.yml` and `config/prices.json`.
- Only `src/llm/client.ts` imports the Anthropic SDK. Tests never call the real API or run the real `claude` binary.
- Ask before any command that spends API money or plan usage (live `claude` calls). The benchmark runs in batches with a hard call cap per batch (PLAN §9).
- Regex patterns in `config/default-rules.yml` may be refined with tests. Weights and thresholds change only in Phase 4, on the dev split.
- If the plan is wrong, say so in `BUILD_LOG.md` and fix the plan in the same commit. Do not silently diverge.
