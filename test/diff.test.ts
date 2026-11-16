import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatHunk, parseDiff, parseDiffFiles } from "../src/tier0/diff";

const fx = (n: string) => readFileSync(`test/fixtures/${n}`, "utf8");

describe("parseDiff", () => {
  const files = parseDiffFiles(fx("multi.diff"));
  const byPath = (p: string) => files.find((f) => f.path === p)!;

  it("finds every file", () => {
    expect(files.map((f) => f.path)).toEqual([
      "lib/big.txt",
      "lib/blob.bin",
      "lib/gone.txt",
      "lib/new-name.txt",
      "lib/new.txt",
      "lib/nonl.txt",
      "lib/pure-new.txt",
    ]);
  });

  it("splits multiple hunks with 1-based ids and line numbers", () => {
    const big = byPath("lib/big.txt");
    expect(big.hunks.map((h) => h.id)).toEqual(["lib/big.txt#1", "lib/big.txt#2"]);
    const h2 = big.hunks[1]!;
    expect(h2.header).toBe("line 32");
    expect(h2.added).toBe(1);
    expect(h2.deleted).toBe(1);
    const del = h2.lines.find((l) => l.kind === "del")!;
    expect(del).toMatchObject({ text: "line 36", oldNo: 36 });
    expect(h2.lines.find((l) => l.kind === "add")).toMatchObject({ text: "line thirty-six", newNo: 36 });
  });

  it("handles new, deleted and renamed files", () => {
    expect(byPath("lib/new.txt")).toMatchObject({ status: "added" });
    expect(byPath("lib/new.txt").hunks[0]).toMatchObject({ added: 2, deleted: 0, oldStart: 0 });
    const gone = byPath("lib/gone.txt");
    expect(gone.status).toBe("deleted");
    expect(gone.hunks[0]).toMatchObject({ file: "lib/gone.txt", added: 0, deleted: 1 });
    const ren = byPath("lib/new-name.txt");
    expect(ren).toMatchObject({ status: "renamed", oldPath: "lib/old-name.txt" });
    expect(ren.hunks[0]).toMatchObject({ oldFile: "lib/old-name.txt", id: "lib/new-name.txt#1" });
  });

  it("records binary and pure-rename files with no hunks", () => {
    expect(byPath("lib/blob.bin")).toMatchObject({ binary: true, hunks: [] });
    expect(byPath("lib/pure-new.txt")).toMatchObject({ status: "renamed", hunks: [] });
  });

  it("ignores 'No newline at end of file' markers", () => {
    const h = byPath("lib/nonl.txt").hunks[0]!;
    expect(h.lines.map((l) => [l.kind, l.text])).toEqual([
      ["del", "no newline"],
      ["add", "no newline changed"],
    ]);
  });

  it("flattens to Hunk[]", () => {
    expect(parseDiff(fx("multi.diff"))).toHaveLength(6);
    expect(parseDiff("")).toEqual([]);
  });

  it("round-trips a hunk", () => {
    const h = parseDiff(fx("readme.diff"))[0]!;
    expect(formatHunk(h)).toContain("+Hello there.");
    expect(formatHunk(h).startsWith("@@ -1,3 +1,3 @@")).toBe(true);
  });
});
