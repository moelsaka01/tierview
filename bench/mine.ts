// P4-01: collect candidate (bug-introducing B, fix F) pairs into bench/candidates.jsonl. Spec: PLAN.md §9.
// Only maintainer-attested links count: a `Fixes: <sha>` trailer, "Regression in <sha>", "introduced in <sha>",
// or (for squash-merge repos) "regression from #<PR>", resolved to the PR's merge commit. Plain SZZ is not used.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH, ghGet, sleep } from "./lib/sh";

export interface Source {
  repo: string;
  language: string;
  queries: string[];
  pages: number;
  pr_refs?: boolean;
}

export interface Candidate {
  repo: string;
  language: string;
  fix_sha: string;
  fix_date: string;
  fix_subject: string;
  fix_message: string;
  /** A commit sha (possibly abbreviated) or "#<PR number>". */
  intro_ref: string;
  link: "fixes-trailer" | "regression-in" | "introduced-phrase" | "pr-ref";
  /** Filled for pr-ref after resolving the PR. */
  intro_sha?: string;
}

const PATTERNS: { link: Candidate["link"]; re: RegExp }[] = [
  { link: "fixes-trailer", re: /^\s*Fixes:\s*([0-9a-f]{7,40})\b/gim },
  { link: "regression-in", re: /\bRegression in ([0-9a-f]{7,40})\b/g },
  { link: "introduced-phrase", re: /\b(?:introduced|regression|regressed|caused|broken|broke)\s+(?:in|by|from|since|with)\s+(?:commit\s+)?([0-9a-f]{7,40})\b/gi },
];
const PR_PATTERN = /\b(?:regression|regressed|introduced|caused|broken|broke)\b[^\n.]{0,40}?#(\d{3,6})\b/gi;

/** Every attested reference to an introducing change in a fix message. Pure, for tests. */
export function extractRefs(message: string, prRefs = false): { ref: string; link: Candidate["link"] }[] {
  const out: { ref: string; link: Candidate["link"] }[] = [];
  const seen = new Set<string>();
  for (const { link, re } of PATTERNS) {
    for (const m of message.matchAll(re)) {
      const ref = m[1]!.toLowerCase();
      // a 7+ char run of digits only is more likely an issue number than a sha
      if (/^\d+$/.test(ref) || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, link });
    }
  }
  if (prRefs) {
    for (const m of message.matchAll(PR_PATTERN)) {
      const ref = `#${m[1]}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, link: "pr-ref" });
    }
  }
  return out;
}

interface SearchItem {
  sha: string;
  commit: { message: string; committer: { date: string } };
}

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(join(BENCH, "sources.json"), "utf8")) as { since: string; sources: Source[] };
  const out: Candidate[] = [];
  const seen = new Set<string>();
  // `mine [repo ...]`: only these sources, appended to candidates.jsonl; no args: all sources, file rewritten.
  const only = process.argv.slice(2);
  for (const s of cfg.sources.filter((x) => !only.length || only.includes(x.repo))) {
    let n = 0;
    for (const q of s.queries) {
      for (let page = 1; page <= s.pages; page++) {
        await sleep(2200); // commit search: 30 requests per minute
        const res = ghGet<{ items: SearchItem[] }>("search/commits", { q: `${q} repo:${s.repo} committer-date:>${cfg.since}`, per_page: 100, page });
        for (const it of res.items) {
          for (const { ref, link } of extractRefs(it.commit.message, s.pr_refs)) {
            const key = `${s.repo} ${it.sha} ${ref}`;
            if (seen.has(key) || it.sha.startsWith(ref)) continue;
            seen.add(key);
            out.push({
              repo: s.repo,
              language: s.language,
              fix_sha: it.sha,
              fix_date: it.commit.committer.date,
              fix_subject: it.commit.message.split("\n")[0]!,
              fix_message: it.commit.message,
              intro_ref: ref,
              link,
            });
            n++;
          }
        }
        if (res.items.length < 100) break;
      }
    }
    // Resolve "#PR" to the PR's merge commit (squash merge on the default branch).
    for (const c of out.filter((c) => c.repo === s.repo && c.link === "pr-ref")) {
      try {
        const pr = ghGet<{ merged_at: string | null; merge_commit_sha: string | null }>(`repos/${s.repo}/pulls/${c.intro_ref.slice(1)}`);
        if (pr.merged_at && pr.merge_commit_sha) c.intro_sha = pr.merge_commit_sha;
      } catch {
        // an issue number, not a PR
      }
    }
    process.stderr.write(`${s.repo}: ${n} candidate link(s)\n`);
  }
  const kept = out.filter((c) => c.link !== "pr-ref" || c.intro_sha);
  const lines = kept.map((c) => JSON.stringify(c)).join("\n") + "\n";
  if (only.length) appendFileSync(join(BENCH, "candidates.jsonl"), lines);
  else writeFileSync(join(BENCH, "candidates.jsonl"), lines);
  process.stderr.write(`wrote ${kept.length} candidates to bench/candidates.jsonl\n`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/mine.js")) await main();
