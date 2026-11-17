// SARIF 2.1.0 output. Mapping: PLAN.md §8 (ruleId = category; level from severity; properties = model, tier, confidence).
import type { Finding, Review, Severity } from "../types";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" };

function result(f: Finding) {
  const text = [f.title, f.explanation, f.suggestion ? `Suggestion: ${f.suggestion}` : ""].filter(Boolean).join("\n\n");
  return {
    ruleId: f.category,
    level: LEVEL[f.severity],
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: Math.max(1, f.start_line), endLine: Math.max(f.start_line, f.end_line, 1) },
        },
      },
    ],
    partialFingerprints: { tierviewFindingId: f.id },
    properties: { model: f.model, tier: f.tier, confidence: f.confidence, severity: f.severity, side: f.side },
  };
}

export function reviewSarif(r: Review, version = "0.0.1"): string {
  const rules = [...new Set(r.findings.map((f) => f.category))].sort().map((id) => ({ id, name: id, shortDescription: { text: `tierview: ${id}` } }));
  const doc = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "tierview", version, informationUri: "https://github.com/moelsaka01/tierview", rules } },
        results: r.findings.map(result),
      },
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
