// P4-02: validate candidate pairs, select clean commits, write bench/cases/. Spec: PLAN.md §9.
//   validate  -> bench/validated.jsonl   (every candidate, ok or with the reason it was rejected)
//   clean <repo> <language> <since> <until> <n>  -> appends presumed-clean commits to bench/clean.jsonl
//   make <selection.json>  -> bench/cases/<id>.json + <id>.diff
// Runs against local blobless clones in bench/repos/ (not committed).
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./mine";
import { BENCH, ensureClone, ghGet, git } from "./lib/sh";

export const LIMITS = { bugMaxLines: 400, bugMaxFiles: 15, fixMaxLines: 60, cleanMinLines: 10 };

export const LANG_EXT: Record<string, RegExp> = {
  C: /\.[ch]$/,
  Go: /\.go$/,
  Python: /\.py$/,
  Rust: /\.rs$/,
  TypeScript: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/,
};
const TEST_PATH = /(^|\/)(tests?|testing|__tests__|spec)(\/|$)|_test\.go$|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$/;

// ---- pure helpers (tested) ----------------------------------------------

/** Old-side line ranges removed or changed, per old path, from a `-U0` unified diff. New files have none. */
export function removedRanges(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let path: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) path = null;
    else if (line.startsWith("--- ")) path = line === "--- /dev/null" ? null : line.slice(4).replace(/^a\//, "");
    else if (line.startsWith("@@") && path) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      if (len > 0) {
        if (!out.has(path)) out.set(path, []);
        out.get(path)!.push([start, start + len - 1]);
      }
    }
  }
  return out;
}

export interface BlameLine {
  sha: string;
  orig: number;
  final: number;
  filename: string;
}

/** Parses `git blame --line-porcelain`. */
export function parseLinePorcelain(text: string): BlameLine[] {
  const out: BlameLine[] = [];
  let cur: Partial<BlameLine> | null = null;
  for (const line of text.split("\n")) {
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (h) {
      cur = { sha: h[1]!, orig: Number(h[2]), final: Number(h[3]) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("filename ")) cur.filename = line.slice(9);
    else if (line.startsWith("\t")) {
      out.push(cur as BlameLine);
      cur = null;
    }
  }
  return out;
}

export interface Numstat {
  files: { path: string; added: number; deleted: number }[];
  added: number;
  deleted: number;
}

/** Parses `git diff --numstat` (binary files count as a file with 0 lines). Renames use the new path. */
export function parseNumstat(text: string): Numstat {
  const files = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [a, d, ...p] = l.split("\t");
      let path = p.join("\t");
      const br = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
      if (br) path = `${br[1]}${br[3]}${br[4]}`.replace(/\/\//g, "/");
      else if (path.includes(" => ")) path = path.split(" => ")[1]!;
      return { path, added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d) };
    });
  return { files, added: files.reduce((s, f) => s + f.added, 0), deleted: files.reduce((s, f) => s + f.deleted, 0) };
}

/** Share of changed lines in files of the language (tests included). */
export function languageShare(ns: Numstat, language: string): number {
  const re = LANG_EXT[language];
  const total = ns.added + ns.deleted;
  if (!re || total === 0) return 0;
  return ns.files.filter((f) => re.test(f.path)).reduce((s, f) => s + f.added + f.deleted, 0) / total;
}

/** Size rules for a buggy pair (§9). Returns the reason it fails, or null. */
export function sizeProblem(bug: Numstat, fix: Numstat): string | null {
  if (bug.files.length > LIMITS.bugMaxFiles) return `B touches ${bug.files.length} files (> ${LIMITS.bugMaxFiles})`;
  if (bug.added + bug.deleted > LIMITS.bugMaxLines) return `B changes ${bug.added + bug.deleted} lines (> ${LIMITS.bugMaxLines})`;
  if (fix.added + fix.deleted > LIMITS.fixMaxLines) return `F changes ${fix.added + fix.deleted} lines (> ${LIMITS.fixMaxLines})`;
  return null;
}

/** Collapses sorted line numbers into "a-b" ranges for readability. */
export function ranges(lines: number[]): string {
  const s = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(",");
}

// ---- git-backed steps ------------------------------------------------------

const parents = (dir: string, sha: string) => git(dir, ["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").slice(1);
/**
 * Numstat from the GitHub commits API. A local `git diff --numstat` in a blobless clone fetches every blob one at a
 * time, which made validation take minutes per candidate; the API answers in one request.
 */
const statCache = new Map<string, Numstat>();
function numstat(repo: string, sha: string): Numstat {
  const k = `${repo}@${sha}`;
  if (!statCache.has(k)) {
    const c = ghGet<{ files?: { filename: string; additions: number; deletions: number }[] }>(`repos/${repo}/commits/${sha}`);
    const files = (c.files ?? []).map((f) => ({ path: f.filename, added: f.additions, deleted: f.deletions }));
    statCache.set(k, { files, added: files.reduce((a, f) => a + f.added, 0), deleted: files.reduce((a, f) => a + f.deleted, 0) });
  }
  return statCache.get(k)!;
}

/** Lines of `intro` (in intro's version of the file) that `change` removed or rewrote, via blame limited to intro^..change^. */
export function blameInto(dir: string, intro: string, change: string): { file: string; lines: number[] }[] {
  const rr = removedRanges(git(dir, ["diff", "-U0", "-M", `${change}^`, change]));
  const byFile = new Map<string, number[]>();
  for (const [path, rs] of rr) {
    const args = ["blame", "--line-porcelain", ...rs.flatMap(([a, b]) => ["-L", `${a},${b}`]), `${intro}^..${change}^`, "--", path];
    for (const l of parseLinePorcelain(git(dir, args, { allowFail: true }))) {
      if (l.sha !== intro) continue;
      if (!byFile.has(l.filename)) byFile.set(l.filename, []);
      byFile.get(l.filename)!.push(l.orig);
    }
  }
  return [...byFile].map(([file, lines]) => ({ file, lines: [...new Set(lines)].sort((a, b) => a - b) }));
}

export interface Validated extends Candidate {
  ok: boolean;
  reason?: string;
  bug_sha?: string;
  bug_date?: string;
  bug_subject?: string;
  bug_stats?: { files: number; added: number; deleted: number };
  fix_stats?: { files: number; added: number; deleted: number };
  fix_files?: string[];
  faulty?: { file: string; lines: number[] }[];
}

export function validateOne(c: Candidate): Validated {
  const dir = ensureClone(c.repo);
  const reject = (reason: string): Validated => ({ ...c, ok: false, reason });
  const ref = c.intro_sha ?? c.intro_ref;
  const B = git(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { allowFail: true }).trim();
  const F = git(dir, ["rev-parse", "--verify", "-q", `${c.fix_sha}^{commit}`], { allowFail: true }).trim();
  if (!B) return reject(`B ${ref} not found (or ambiguous)`);
  if (!F) return reject("F not on the default branch");
  if (B === F) return reject("B equals F");
  const bp = parents(dir, B);
  const fp = parents(dir, F);
  if (bp.length !== 1) return reject(bp.length ? "B is a merge commit" : "B is a root commit");
  if (fp.length !== 1) return reject("F is a merge commit");
  if (git(dir, ["merge-base", B, F], { allowFail: true }).trim() !== B) return reject("B is not an ancestor of F");
  const fn = numstat(c.repo, F);
  if (fn.added + fn.deleted > LIMITS.fixMaxLines) return reject(`F changes ${fn.added + fn.deleted} lines (> ${LIMITS.fixMaxLines})`);
  const bn = numstat(c.repo, B);
  const size = sizeProblem(bn, fn);
  if (size) return reject(size);
  if (languageShare(bn, c.language) < 0.5) return reject(`B is mostly not ${c.language}`);
  const faulty = blameInto(dir, B, F).filter((f) => LANG_EXT[c.language]!.test(f.file));
  if (!faulty.length) return reject(`blame: no ${c.language} line that F removed or changed comes from B`);
  const [bugDate, bugSubject] = git(dir, ["log", "-1", "--format=%cI%n%s", B]).split("\n");
  return {
    ...c,
    ok: true,
    bug_sha: B,
    bug_date: bugDate,
    bug_subject: bugSubject,
    bug_stats: { files: bn.files.length, added: bn.added, deleted: bn.deleted },
    fix_stats: { files: fn.files.length, added: fn.added, deleted: fn.deleted },
    fix_files: fn.files.map((f) => f.path),
    faulty,
  };
}

const FIX_WORDS = /\b(fix(es|ed)?|bug|regress(ion)?|revert)\b/i;

/**
 * Presumed-clean commits (§9): non-merge, size-matched, mostly `language`, not tests or docs only, no later commit
 * message names them, and none of their lines was rewritten by a fix-labelled commit within 12 months.
 */
export function findClean(repo: string, language: string, since: string, until: string, n: number, seed = 1): Validated[] {
  const dir = ensureClone(repo);
  const shas = git(dir, ["log", "--no-merges", `--since=${since}`, `--until=${until}`, "--format=%H"]).trim().split("\n").filter(Boolean);
  // deterministic shuffle
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = shas.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shas[i], shas[j]] = [shas[j]!, shas[i]!];
  }
  const out: Validated[] = [];
  for (const C of shas) {
    if (out.length >= n) break;
    const ns = numstat(repo, C);
    const lines = ns.added + ns.deleted;
    if (lines < LIMITS.cleanMinLines || lines > LIMITS.bugMaxLines || ns.files.length > LIMITS.bugMaxFiles) continue;
    if (languageShare(ns, language) < 0.5) continue;
    const re = LANG_EXT[language]!;
    if (!ns.files.some((f) => re.test(f.path) && !TEST_PATH.test(f.path))) continue;
    const [date, subject] = git(dir, ["log", "-1", "--format=%cI%n%s", C]).split("\n");
    if (/revert/i.test(subject ?? "")) continue;
    if (git(dir, ["log", "--format=%H", "-i", `--grep=${C.slice(0, 8)}`, `${C}..HEAD`]).trim()) continue;
    const end = new Date(new Date(date!).getTime() + 365 * 86400_000).toISOString();
    const later = git(dir, ["log", "--no-merges", "--format=%H%x09%s", `--until=${end}`, `${C}..HEAD`, "--", ...ns.files.map((f) => f.path)])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .filter(([, s]) => FIX_WORDS.test(s ?? ""));
    // Bound the blame work: a commit whose files saw more than 10 fix-labelled commits in a year is skipped (hot code).
    if (later.length > 10) continue;
    let touched = false;
    for (const [X] of later) {
      if (blameInto(dir, C, X!).length) {
        touched = true;
        break;
      }
    }
    if (touched) continue;
    out.push({
      repo,
      language,
      fix_sha: "",
      fix_date: "",
      fix_subject: "",
      fix_message: "",
      intro_ref: C,
      link: "fixes-trailer",
      ok: true,
      bug_sha: C,
      bug_date: date,
      bug_subject: subject,
      bug_stats: { files: ns.files.length, added: ns.added, deleted: ns.deleted },
    });
    process.stderr.write(`  clean: ${repo} ${C.slice(0, 12)} ${subject}\n`);
  }
  return out;
}

// ---- case files ----------------------------------------------------------

export interface Selection {
  id: string;
  kind: "buggy" | "clean";
  split: "dev" | "test" | "test2";
  pilot?: boolean;
  repo: string;
  sha: string;
  fix_sha?: string;
  /** One sentence, from F's message (buggy only). */
  bug?: string;
}

export interface BenchCase {
  id: string;
  kind: "buggy" | "clean";
  split: "dev" | "test" | "test2";
  pilot: boolean;
  repo: string;
  language: string;
  commit: string;
  commit_date: string;
  subject: string;
  url: string;
  stats: { files: number; added: number; deleted: number };
  fix: null | { sha: string; date: string; subject: string; url: string; link: string; files: string[]; bug: string };
  /** Lines of `commit` (new side) that the fix removed or rewrote. Empty for clean cases. */
  faulty: { file: string; lines: number[] }[];
}

function makeCases(selectionFile: string): void {
  const sel = JSON.parse(readFileSync(selectionFile, "utf8")) as Selection[];
  const pool = [join(BENCH, "validated.jsonl"), join(BENCH, "clean.jsonl")]
    .filter(existsSync)
    .flatMap((f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Validated))
    .filter((v) => v.ok);
  const dirOut = join(BENCH, "cases");
  mkdirSync(dirOut, { recursive: true });
  for (const s of sel) {
    const v = pool.find((p) => p.repo === s.repo && p.bug_sha?.startsWith(s.sha) && (s.kind === "clean" ? !p.fix_sha : !s.fix_sha || p.fix_sha.startsWith(s.fix_sha)));
    if (!v) throw new Error(`selection ${s.id}: not found in validated.jsonl / clean.jsonl`);
    const dir = ensureClone(v.repo);
    const diff = git(dir, ["diff", "--no-color", "-U3", "-M", `${v.bug_sha}^`, v.bug_sha!]);
    writeFileSync(join(dirOut, `${s.id}.diff`), diff);
    // The judge sees the fix (PLAN §9); the reviewer never does.
    if (s.kind === "buggy") writeFileSync(join(dirOut, `${s.id}.fix.diff`), git(dir, ["diff", "--no-color", "-U3", "-M", `${v.fix_sha}^`, v.fix_sha]));
    const c: BenchCase = {
      id: s.id,
      kind: s.kind,
      split: s.split,
      pilot: !!s.pilot,
      repo: v.repo,
      language: v.language,
      commit: v.bug_sha!,
      commit_date: v.bug_date!,
      subject: v.bug_subject!,
      url: `https://github.com/${v.repo}/commit/${v.bug_sha}`,
      stats: v.bug_stats!,
      fix:
        s.kind === "buggy"
          ? { sha: v.fix_sha, date: v.fix_date, subject: v.fix_subject, url: `https://github.com/${v.repo}/commit/${v.fix_sha}`, link: v.link, files: v.fix_files ?? [], bug: s.bug ?? v.fix_subject }
          : null,
      faulty: s.kind === "buggy" ? v.faulty ?? [] : [],
    };
    writeFileSync(join(dirOut, `${s.id}.json`), JSON.stringify(c, null, 2) + "\n");
  }
  process.stderr.write(`wrote ${sel.length} case(s) to bench/cases/\n`);
}

async function main(): Promise<void> {
  const [cmd = "validate", ...rest] = process.argv.slice(2);
  if (cmd === "validate") {
    const cands = readFileSync(join(BENCH, "candidates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Candidate);
    // validate [perRepo] [repo]: append-only and resumable; one process per repo can run in parallel.
    const perRepo = Number(rest[0] ?? 10);
    const only = rest[1];
    const outFile = join(BENCH, "validated.jsonl");
    const done = existsSync(outFile) ? readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Validated) : [];
    const keyOf = (c: Candidate) => `${c.repo} ${c.fix_sha} ${c.intro_ref}`;
    const seen = new Set(done.map(keyOf));
    const okBy = new Map<string, number>();
    for (const v of done) if (v.ok) okBy.set(v.repo, (okBy.get(v.repo) ?? 0) + 1);
    cands.sort((a, b) => b.fix_date.localeCompare(a.fix_date)); // newest fixes first (less training contamination)
    for (const c of cands) {
      if ((only && c.repo !== only) || seen.has(keyOf(c)) || (okBy.get(c.repo) ?? 0) >= perRepo) continue;
      let v: Validated;
      try {
        v = validateOne(c);
      } catch (e) {
        v = { ...c, ok: false, reason: `error: ${(e as Error).message.split("\n")[0]}` };
      }
      if (v.ok) okBy.set(c.repo, (okBy.get(c.repo) ?? 0) + 1);
      appendFileSync(outFile, JSON.stringify(v) + "\n");
      process.stderr.write(`${v.ok ? "ok  " : "drop"} ${c.repo} ${c.fix_sha.slice(0, 10)} <- ${c.intro_ref}${v.reason ? `: ${v.reason}` : ""}\n`);
    }
  } else if (cmd === "clean") {
    const [repo, language, since, until, n] = rest;
    const found = findClean(repo!, language!, since!, until!, Number(n ?? 2));
    for (const f of found) appendFileSync(join(BENCH, "clean.jsonl"), JSON.stringify(f) + "\n");
  } else if (cmd === "make") {
    makeCases(rest[0] ?? join(BENCH, "selection.json"));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/validate.js")) await main();
