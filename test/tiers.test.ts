// P3-02 prompts, P3-03 batch, P3-04 context.
import { describe, expect, it } from "vitest";
import { loadEstimates } from "../src/estimate";
import { hunkBlock, numberedHunk, sharedContext, systemPrompt, userMessage } from "../src/llm/prompts";
import { limitsFor, packHunks } from "../src/tiers/batch";
import { CONTEXT, contextFor, enclosingStart } from "../src/tiers/context";
import type { ScoredHunk } from "../src/types";
import { cfg, hunk } from "./helpers";

const est = loadEstimates();
const scored = (file: string, n: number, tier: 0 | 1 | 2 | 3, score = 10): ScoredHunk => ({ ...hunk(file, ["+x"], "modified", n), fileKind: "source", score, tier, reasons: [] });

describe("prompts", () => {
  const routed = [scored("b.ts", 1, 2, 40), scored("a.ts", 2, 1), scored("a.ts", 1, 3, 70)];

  it("builds byte-identical shared context regardless of input order", () => {
    const a = sharedContext(routed, { title: "Fix login", body: "Details" });
    const b = sharedContext([...routed].reverse(), { title: "Fix login", body: "Details" });
    expect(a).toBe(b);
    expect(a).toContain("a.ts#1 tier=3 score=70");
    expect(a.indexOf("a.ts#1")).toBeLessThan(a.indexOf("a.ts#2"));
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("has one stable system prompt per tier, long enough to cache with the shared context", () => {
    for (const t of [1, 2, 3] as const) {
      expect(systemPrompt(t)).toBe(systemPrompt(t));
      expect(systemPrompt(t)).toContain(`Tier ${t}`);
      expect(Math.ceil(systemPrompt(t).length / est.chars_per_token)).toBeGreaterThan(512);
    }
    expect(systemPrompt(3)).toContain("needs_escalation is always false");
  });

  it("numbers hunk lines on both sides and includes prior findings", () => {
    const h = { ...hunk("a.ts", [" ctx", "-old", "+new"]), fileKind: "source" as const, score: 5, tier: 2 as const, reasons: [] };
    const text = numberedHunk(h);
    expect(text.split("\n")[1]).toMatch(/^\s+1\s+1\s+ctx$/);
    expect(text).toContain("- old");
    const block = hunkBlock({ hunk: h, context: { start: 1, end: 2, lines: ["ctx", "new"], kind: "±30 lines" }, prior: [] });
    expect(block).toContain('<context lines="1-2" kind="±30 lines">');
    expect(userMessage([block], [h.id])).toContain("a.ts#1");
  });
});

describe("batch", () => {
  const t = () => 100;

  it("packs Tier 1 across files on the api backend within the hunk limit, keeping files together", () => {
    const hs = Array.from({ length: 14 }, (_, i) => scored(`f${String(i % 5).padStart(2, "0")}.ts`, Math.floor(i / 5) + 1, 1));
    const packs = packHunks(hs, limitsFor("api", 1, cfg, est), t);
    expect(packs.every((p) => p.length <= est.tier1_batch.max_hunks)).toBe(true);
    expect(packs.flat().length).toBe(14);
    for (const p of packs) for (const f of new Set(p.map((h) => h.file))) expect(packs.filter((q) => q.some((h) => h.file === f)).length).toBe(1);
  });

  it("respects the token limit", () => {
    const hs = Array.from({ length: 4 }, (_, i) => scored(`f${i}.ts`, 1, 1));
    expect(packHunks(hs, { mode: "batch", maxHunks: 99, maxTokens: 250 }, t).map((p) => p.length)).toEqual([2, 2]);
  });

  it("splits a file that alone exceeds the limits", () => {
    const hs = Array.from({ length: 5 }, (_, i) => scored("big.ts", i + 1, 1));
    expect(packHunks(hs, { mode: "batch", maxHunks: 2, maxTokens: 1e9 }, t).map((p) => p.length)).toEqual([2, 2, 1]);
  });

  it("uses one request per file for Tiers 2 and 3 on the api backend", () => {
    const hs = [scored("a.ts", 1, 2), scored("a.ts", 2, 2), scored("b.ts", 1, 2)];
    expect(packHunks(hs, limitsFor("api", 2, cfg, est), t).map((p) => p.map((h) => h.id))).toEqual([["a.ts#1", "a.ts#2"], ["b.ts#1"]]);
  });

  it("batches every tier across files on the claude-code backend", () => {
    const hs = [scored("a.ts", 1, 3), scored("b.ts", 1, 3), scored("c.ts", 1, 3)];
    expect(packHunks(hs, limitsFor("claude-code", 3, cfg, est), t)).toHaveLength(1);
  });
});

describe("context", () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const at = (newStart: number, newLines: number, header = "") => ({ ...hunk("a.ts", ["+x"]), newStart, newLines, header });

  it("gives Tier 1 no context and handles a missing file", () => {
    expect(contextFor(at(10, 2), 1, file(50))).toBeNull();
    expect(contextFor(at(10, 2), 2, null)).toBeNull();
  });

  it("gives Tier 2 ±30 lines, clipped to the file", () => {
    const c = contextFor(at(100, 5), 2, file(200))!;
    expect([c.start, c.end]).toEqual([70, 134]);
    expect(contextFor(at(5, 2), 2, file(20))).toMatchObject({ start: 1, end: 20 });
  });

  it("gives Tier 3 the whole file up to 400 lines", () => {
    expect(contextFor(at(100, 5), 3, file(CONTEXT.tier3WholeFileMax))).toMatchObject({ start: 1, end: 400, kind: "whole file" });
  });

  it("gives Tier 3 ±80 lines plus the enclosing function on a long file", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => (i === 499 ? "function handler(req) {" : `  stmt ${i + 1}`));
    const h = at(650, 4, "function handler(req) {");
    expect(enclosingStart(lines, h)).toBe(500);
    const c = contextFor(h, 3, lines.join("\n"))!;
    expect([c.start, c.end]).toEqual([500, 733]);
    expect(c.kind).toContain("enclosing function");
    expect(contextFor(at(650, 4), 3, lines.join("\n"))).toMatchObject({ start: 570, end: 733 });
  });
});
