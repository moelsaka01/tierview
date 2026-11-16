// P4-01 / P4-02: candidate extraction and validation helpers (pure parts; no network, no clones).
import { describe, expect, it } from "vitest";
import { extractRefs } from "../bench/mine";
import { parseDiff } from "../src/tier0/diff";
import { faultyHunks, loadCases } from "../bench/routing";
import { languageShare, parseLinePorcelain, parseNumstat, ranges, removedRanges, sizeProblem } from "../bench/validate";

describe("extractRefs", () => {
  it("finds Fixes: trailers, Django's 'Regression in', and 'introduced in <sha>'", () => {
    const msg = "net: fix a leak\n\nThe buffer was never freed; introduced in commit abcdef1234.\n\nFixes: 0123456789ab (\"net: add buffer\")\nSigned-off-by: X";
    expect(extractRefs(msg)).toEqual([
      { ref: "0123456789ab", link: "fixes-trailer" },
      { ref: "abcdef1234", link: "introduced-phrase" },
    ]);
    expect(extractRefs("Fixed #36000 -- Fixed crash.\n\nRegression in 4f5e6d7c8b9a.")).toEqual([{ ref: "4f5e6d7c8b9a", link: "regression-in" }]);
  });

  it("ignores issue numbers and only reads PR refs when asked", () => {
    expect(extractRefs("Fixes: #1234\nFixes: 1234567")).toEqual([]);
    const msg = "fix: restore the cache key (regression from #81234)";
    expect(extractRefs(msg)).toEqual([]);
    expect(extractRefs(msg, true)).toEqual([{ ref: "#81234", link: "pr-ref" }]);
  });
});

describe("validation helpers", () => {
  it("reads removed old-side ranges from a -U0 diff, skipping pure additions and new files", () => {
    const diff = [
      "diff --git a/src/a.c b/src/a.c",
      "--- a/src/a.c",
      "+++ b/src/a.c",
      "@@ -10,2 +10,3 @@ int f(void)",
      "@@ -20 +21 @@",
      "@@ -30,0 +31,2 @@",
      "diff --git a/new.c b/new.c",
      "--- /dev/null",
      "+++ b/new.c",
      "@@ -0,0 +1,5 @@",
    ].join("\n");
    expect([...removedRanges(diff)]).toEqual([["src/a.c", [[10, 11], [20, 20]]]]);
  });

  it("parses line-porcelain blame", () => {
    const sha = "a".repeat(40);
    const text = [`${sha} 7 10 1`, "author X", "filename old/a.c", "\tint x;", `${"b".repeat(40)} 3 11`, "boundary", "filename src/a.c", "\tint y;"].join("\n");
    expect(parseLinePorcelain(text)).toEqual([
      { sha, orig: 7, final: 10, filename: "old/a.c" },
      { sha: "b".repeat(40), orig: 3, final: 11, filename: "src/a.c" },
    ]);
  });

  it("parses numstat with renames and binaries, and applies the size rules", () => {
    const ns = parseNumstat("10\t2\tsrc/a.go\n-\t-\timg.png\n3\t1\tpkg/{old => new}/b.go\n5\t0\tREADME.md\n");
    expect(ns.files.map((f) => f.path)).toEqual(["src/a.go", "img.png", "pkg/new/b.go", "README.md"]);
    expect([ns.added, ns.deleted]).toEqual([18, 3]);
    expect(languageShare(ns, "Go")).toBeCloseTo(16 / 21);
    expect(sizeProblem(ns, parseNumstat("1\t1\ta.go\n"))).toBeNull();
    expect(sizeProblem(ns, parseNumstat("50\t20\ta.go\n"))).toMatch(/^F changes 70/);
    expect(sizeProblem(parseNumstat("401\t0\ta.go\n"), ns)).toMatch(/^B changes 401/);
  });

  it("collapses line lists", () => {
    expect(ranges([5, 3, 4, 9, 11, 10])).toBe("3-5,9-11");
  });
});

describe("dataset", () => {
  const cases = loadCases();

  it("has 30 cases: 20 buggy, 10 clean, dev 10 (5 pilot), test 20, at most 6 per repo, 4+ languages", () => {
    const n = (f: (c: (typeof cases)[number]["c"]) => boolean) => cases.filter((x) => f(x.c)).length;
    expect(cases).toHaveLength(30);
    expect(n((c) => c.kind === "buggy")).toBe(20);
    expect(n((c) => c.split === "dev")).toBe(10);
    expect(n((c) => c.pilot)).toBe(5);
    expect(n((c) => c.pilot && c.kind === "buggy")).toBe(3);
    const perRepo = new Map<string, number>();
    for (const { c } of cases) perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
    expect(Math.max(...perRepo.values())).toBeLessThanOrEqual(6);
    expect(new Set(cases.map((x) => x.c.language)).size).toBeGreaterThanOrEqual(4);
  });

  it("every buggy case has a faulty line inside a hunk of its diff; clean cases have none", () => {
    for (const { c, diff } of cases) {
      const hunks = parseDiff(diff);
      expect(hunks.length, c.id).toBeGreaterThan(0);
      if (c.kind === "buggy") expect(faultyHunks(hunks, c.faulty).length, c.id).toBeGreaterThan(0);
      else expect(c.faulty).toEqual([]);
    }
  });
});
