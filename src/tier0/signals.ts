// Deterministic risk signals. Spec: PLAN.md §4. Patterns and weights are data in config/default-rules.yml.
import picomatch from "picomatch";
import type { Config } from "../config";
import type { FileKind, Hunk, Reason } from "../types";
import type { Churn } from "../git";

type Matcher = (p: string) => boolean;
const glob = (patterns: string[]): Matcher => (patterns.length ? picomatch(patterns, { dot: true }) : () => false);
const regexes = (src: string[]) => src.map((s) => new RegExp(s, "i"));

interface CompiledCategory {
  name: string;
  weight: number;
  path: RegExp[];
  content: RegExp[];
  added: RegExp[];
  removed: RegExp[];
  logic: string[];
}

export interface Rules {
  cfg: Config;
  kinds: { generated: Matcher; docs: Matcher; test: Matcher; config: Matcher };
  categories: CompiledCategory[];
}

export function compileRules(cfg: Config): Rules {
  return {
    cfg,
    kinds: {
      generated: glob(cfg.file_kinds.generated),
      docs: glob(cfg.file_kinds.docs),
      test: glob(cfg.file_kinds.test),
      config: glob(cfg.file_kinds.config),
    },
    categories: Object.entries(cfg.categories).map(([name, c]) => ({
      name,
      weight: c.weight,
      path: regexes(c.path),
      content: regexes(c.content),
      added: regexes(c.content_added),
      removed: regexes(c.content_removed),
      logic: c.logic,
    })),
  };
}

export function fileKindOf(path: string, rules: Rules): FileKind {
  if (rules.kinds.generated(path)) return "generated";
  if (rules.kinds.docs(path)) return "docs";
  if (rules.kinds.test(path)) return "test";
  if (rules.kinds.config(path)) return "config";
  return "source";
}

// ---- logic signals ------------------------------------------------------

const lines = (h: Hunk, kind: "add" | "del") => h.lines.filter((l) => l.kind === kind).map((l) => l.text);
const count = (xs: string[], re: RegExp) => xs.filter((x) => re.test(x)).length;

const TEST_FN = /^\s*(it|test)\s*\(|\bdef test_|\bfunc Test\w+|@Test\b|#\[test\]|\b(it|test)\.each\b/;
const ASSERT = /\bexpect\s*\(|\bassert\w*\b|\.should\b|\bt\.(Error|Fatal)f?\s*\(|\bself\.assert\w*/;
const AWAIT = /\b(await|async)\b/;
const COND = /^\s*(\}\s*)?(if|else\s+if|elif|while|for|unless)\b/;
const BOUNDS = /\s(<=|>=|<|>)\s+[^;{]*?(\s[+-]\s|\b(size|len|length|count|end|limit|max|cap|capacity|bound)\w*)/i;
const norm = (t: string) => t.replace(/\s+/g, "");
const CMP = /<=|>=|===|!==|==|!=|=>|->|<<|>>|<|>/g;

function comparisons(s: string): string {
  return (s.match(CMP) ?? []).filter((t) => t !== "=>" && t !== "->" && t !== "<<" && t !== ">>").join(" ");
}

function brackets(s: string): string {
  const out: string[] = [];
  for (const m of s.matchAll(/\[([^[\]]*)\]/g)) {
    const inner = m[1] as string;
    if (/[+-]|len|length|size/i.test(inner)) out.push(inner.replace(/\s+/g, ""));
  }
  return out.join("|");
}

/** Pairs the i-th deleted line with the i-th added line of each change block. */
function modifiedPairs(h: Hunk): [string, string][] {
  const pairs: [string, string][] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) pairs.push([dels[i] as string, adds[i] as string]);
    dels = [];
    adds = [];
  };
  let inAdds = false;
  for (const l of h.lines) {
    if (l.kind === "del") {
      if (inAdds) {
        flush();
        inAdds = false;
      }
      dels.push(l.text);
    } else if (l.kind === "add") {
      inAdds = true;
      adds.push(l.text);
    } else {
      flush();
      inAdds = false;
    }
  }
  flush();
  return pairs;
}

function logicFires(name: string, h: Hunk, kind: FileKind): string | null {
  const added = lines(h, "add");
  const removed = lines(h, "del");
  switch (name) {
    case "deleted_test_file":
      return kind === "test" && h.status === "deleted" ? "test file deleted" : null;
    case "deleted_test_function": {
      if (kind !== "test") return null;
      const gone = count(removed, TEST_FN) - count(added, TEST_FN);
      return gone > 0 ? `${gone} test function(s) removed` : null;
    }
    case "test_assertion_count_dropped": {
      if (kind !== "test") return null;
      const drop = count(removed, ASSERT) - count(added, ASSERT);
      return drop > 0 ? `${drop} fewer assertion(s)` : null;
    }
    case "await_added_or_removed": {
      const d = count(added, AWAIT) - count(removed, AWAIT);
      return d !== 0 ? `async/await ${d > 0 ? "added" : "removed"}` : null;
    }
    case "comparison_operator_changed":
      return modifiedPairs(h).some(([a, b]) => comparisons(a) !== comparisons(b)) ? "comparison operator changed" : null;
    case "index_arithmetic_changed":
      return modifiedPairs(h).some(([a, b]) => brackets(a) !== brackets(b)) ? "index arithmetic changed" : null;
    case "condition_changed":
      // Phase 4: an if/while/for condition rewritten on a modified line (e.g. a flag dropped from a mask test).
      return modifiedPairs(h).some(([a, b]) => COND.test(a) && COND.test(b) && norm(a) !== norm(b)) ? "condition changed" : null;
    case "bounds_check_added": {
      // Phase 4: a new relational check against arithmetic or a size-like name (the off-by-one class).
      const hit = h.lines.find((l) => l.kind === "add" && BOUNDS.test(l.text));
      return hit ? `bounds check: ${hit.text.trim().slice(0, 50)}` : null;
    }
    default:
      return null;
  }
}

// ---- category signals ---------------------------------------------------

function firstMatch(res: RegExp[], texts: string[]): string | null {
  for (const re of res) for (const t of texts) if (re.test(t)) return t.trim().slice(0, 60);
  return null;
}

/** One Reason per category that fires (the category weight counts once, however many patterns match). */
export function categorySignals(h: Hunk, kind: FileKind, rules: Rules): Reason[] {
  const added = lines(h, "add");
  const removed = lines(h, "del");
  const both = [...added, ...removed];
  const paths = [h.file, ...(h.oldFile ? [h.oldFile] : [])];
  const out: Reason[] = [];
  for (const c of rules.categories) {
    let detail: string | null = null;
    const p = firstMatch(c.path, paths);
    if (p) detail = `path ${p}`;
    if (!detail) {
      const m = firstMatch(c.content, both) ?? firstMatch(c.added, added) ?? firstMatch(c.removed, removed);
      if (m) detail = `\`${m}\``;
    }
    if (!detail) {
      for (const l of c.logic) {
        const r = logicFires(l, h, kind);
        if (r) {
          detail = r;
          break;
        }
      }
    }
    if (detail) out.push({ signal: c.name, weight: c.weight, detail });
  }
  return out;
}

// ---- trivial hunks ------------------------------------------------------

const COMMENT = /^\s*(\/\/|#(?!include|define|if|endif|pragma)|\/\*|\*\/?|--|<!--|"""|''')/;
const IMPORT = /^\s*(import\s|from\s+\S+\s+import\s|(const|let|var)\s+.*=\s*require\(|#include\s|using\s|use\s+[\w:]+;)/;
const ws = (s: string) => s.replace(/\s+/g, "");

/** Only comments, blank lines, reordered imports, or whitespace-only edits. */
export function isTrivialHunk(h: Hunk): boolean {
  const changed = h.lines.filter((l) => l.kind !== "ctx");
  if (changed.length === 0) return false;
  const added = lines(h, "add").map(ws).filter(Boolean).sort();
  const removed = lines(h, "del").map(ws).filter(Boolean).sort();
  if (added.length === removed.length && added.every((a, i) => a === removed[i])) return true; // whitespace / reorder
  const nonTrivial = changed.filter((l) => l.text.trim() !== "" && !COMMENT.test(l.text) && !IMPORT.test(l.text));
  if (nonTrivial.length > 0) return false;
  const imp = (kind: "add" | "del") => h.lines.filter((l) => l.kind === kind && IMPORT.test(l.text)).map((l) => ws(l.text)).sort();
  const a = imp("add");
  const d = imp("del");
  return a.length === d.length && a.every((x, i) => x === d[i]);
}

// ---- diff-level context and structure signals ---------------------------

export interface DiffContext {
  files: number;
  topDirs: number;
  hunksPerFile: Map<string, number>;
  sourceLinesChanged: number;
  testFileTouched: boolean;
  diffWeakensTests: boolean;
  /** Per-file churn, or null when history is unavailable (shallow clone, PR mode, disabled). */
  churn: Record<string, Churn> | null;
}

export function buildDiffContext(
  hunks: Hunk[],
  kinds: Map<string, FileKind>,
  weakened: boolean,
  churn: Record<string, Churn> | null,
): DiffContext {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const perFile = new Map<string, number>();
  let sourceLines = 0;
  let testTouched = false;
  for (const h of hunks) {
    const kind = kinds.get(h.file) ?? "source";
    perFile.set(h.file, (perFile.get(h.file) ?? 0) + 1);
    if (kind === "generated") continue;
    files.add(h.file);
    dirs.add(h.file.includes("/") ? (h.file.split("/")[0] as string) : ".");
    if (kind === "source") sourceLines += h.added + h.deleted;
    if (kind === "test") testTouched = true;
  }
  return {
    files: files.size,
    topDirs: dirs.size,
    hunksPerFile: perFile,
    sourceLinesChanged: sourceLines,
    testFileTouched: testTouched,
    diffWeakensTests: weakened,
    churn,
  };
}

export function structureSignals(h: Hunk, kind: FileKind, ctx: DiffContext, cfg: Config): Reason[] {
  const s = cfg.structure;
  const out: Reason[] = [];
  const size = h.added + h.deleted;
  const bucket = s.size.find(([max]) => size <= max);
  if (bucket && bucket[1] !== 0) out.push({ signal: "size", weight: bucket[1], detail: `${size} changed lines` });
  const n = ctx.hunksPerFile.get(h.file) ?? 0;
  if (n > s.many_hunks_in_file.more_than) {
    out.push({ signal: "many_hunks_in_file", weight: s.many_hunks_in_file.points, detail: `${n} hunks in this file` });
  }
  if (h.added === 0 && h.deleted > 0) out.push({ signal: "deletion_only", weight: s.deletion_only.points, detail: "only deletions" });
  const churn = ctx.churn?.[h.file];
  if (churn) {
    if (s.churn.enabled && churn.commits >= s.churn.min_commits) {
      out.push({ signal: "churn", weight: s.churn.points, detail: `${churn.commits} commits in ${s.churn.days}d` });
    }
    if (s.hotspot.enabled && churn.fixCommits >= s.hotspot.min_fix_commits) {
      out.push({ signal: "hotspot", weight: s.hotspot.points, detail: `${churn.fixCommits} fix commits in ${s.hotspot.days}d` });
    }
  }
  if (kind === "source") {
    if (ctx.files > s.scatter.max_files || ctx.topDirs > s.scatter.max_top_dirs) {
      out.push({ signal: "scatter", weight: s.scatter.points, detail: `${ctx.files} files, ${ctx.topDirs} top-level dirs` });
    }
    if (ctx.diffWeakensTests) out.push({ signal: "diff_weakens_tests", weight: s.diff_weakens_tests.points, detail: "tests weakened elsewhere in this diff" });
    if (ctx.sourceLinesChanged > s.no_tests_changed.min_source_lines && !ctx.testFileTouched) {
      out.push({ signal: "no_tests_changed", weight: s.no_tests_changed.points, detail: `${ctx.sourceLinesChanged} source lines, no test file` });
    }
  }
  return out;
}
