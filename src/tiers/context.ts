// Surrounding file context per tier. Spec: PLAN.md §5 (context table).
import type { Hunk, LlmTier } from "../types";

export interface ContextBlock {
  /** 1-based, inclusive, new-file line numbers. */
  start: number;
  end: number;
  lines: string[];
  /** "whole file" | "±30 lines" | "±80 lines + enclosing function" */
  kind: string;
}

export const CONTEXT = { tier2Radius: 30, tier3WholeFileMax: 400, tier3Radius: 80, maxFunctionLookback: 200 } as const;

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** New-side span of the hunk (1-based, inclusive). A pure deletion spans its anchor line. */
function span(h: Hunk): [number, number] {
  const start = Math.max(1, h.newStart);
  return [start, Math.max(start, h.newStart + h.newLines - 1)];
}

/** The line where the enclosing function starts, found by matching git's hunk header text above the hunk. */
export function enclosingStart(lines: string[], h: Hunk): number | null {
  const header = h.header.trim();
  if (!header) return null;
  const [start] = span(h);
  for (let i = Math.min(start - 1, lines.length) - 1; i >= Math.max(0, start - 1 - CONTEXT.maxFunctionLookback); i--) {
    if (lines[i]!.trim() === header) return i + 1;
  }
  return null;
}

/**
 * Context for a hunk at a tier. Tier 1 gets none (the diff's own context lines).
 * Returns null when the tier gets none or the file is unavailable (deleted, binary, PR without checkout).
 */
export function contextFor(h: Hunk, tier: LlmTier, fileText: string | null, tier1Context: "none" | "tier3" = "none"): ContextBlock | null {
  // Tier 1 gets no context, or (config tier1_context: tier3, bench-config-v2) exactly Tier 3's.
  if (tier === 1) {
    if (tier1Context !== "tier3") return null;
    tier = 3;
  }
  if (fileText === null || h.status === "deleted") return null;
  const lines = splitLines(fileText);
  if (lines.length === 0) return null;
  const [s, e] = span(h);
  let start: number;
  let end: number;
  let kind: string;
  if (tier === 2) {
    start = s - CONTEXT.tier2Radius;
    end = e + CONTEXT.tier2Radius;
    kind = `±${CONTEXT.tier2Radius} lines`;
  } else if (lines.length <= CONTEXT.tier3WholeFileMax) {
    start = 1;
    end = lines.length;
    kind = "whole file";
  } else {
    start = s - CONTEXT.tier3Radius;
    end = e + CONTEXT.tier3Radius;
    kind = `±${CONTEXT.tier3Radius} lines`;
    const fn = enclosingStart(lines, h);
    if (fn !== null && fn < start) {
      start = fn;
      kind += " + enclosing function";
    }
  }
  start = Math.max(1, start);
  end = Math.min(lines.length, end);
  if (start > end) return null;
  return { start, end, lines: lines.slice(start - 1, end), kind };
}
