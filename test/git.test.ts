import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fileChurn, fileSource, getDiff, untrackedFiles } from "../src/git";
import { parseDiffFiles } from "../src/tier0/diff";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "tierview-git-"));
  sh(repo, "init", "-q");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "t");
  sh(repo, "config", "commit.gpgsign", "false");
  const commit = (file: string, body: string, msg: string) => {
    writeFileSync(join(repo, file), body);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", msg);
  };
  commit("a.txt", "1\n", "add a");
  commit("a.txt", "1\n2\n", "fix crash in a");
  commit("a.txt", "1\n2\n3\n", "Fixes a bug again");
  commit("b.txt", "x\n", "add b");
}, 60_000); // git process start-up can be slow on Windows (antivirus)

describe("getDiff", { timeout: 30_000 }, () => {
  it("diffs the working tree against HEAD by default", () => {
    writeFileSync(join(repo, "b.txt"), "x\ny\n");
    expect(getDiff({ cwd: repo })).toContain("+y");
    sh(repo, "checkout", "--", "b.txt");
    expect(getDiff({ cwd: repo })).toBe("");
  });

  it("supports --staged and base..head", () => {
    writeFileSync(join(repo, "b.txt"), "x\nz\n");
    sh(repo, "add", "b.txt");
    expect(getDiff({ cwd: repo, staged: true })).toContain("+z");
    sh(repo, "reset", "-q", "--hard");
    const d = getDiff({ cwd: repo, base: "HEAD~1", head: "HEAD" });
    expect(d).toContain("b/b.txt");
    expect(d).not.toContain("a.txt");
  });
});

describe("--include-untracked", { timeout: 30_000 }, () => {
  it("adds untracked, non-ignored files as new-file diffs", () => {
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "new.ts"), "export const x = 1;\nexport const y = 2;\n");
    writeFileSync(join(repo, "ignored.txt"), "secret\n");
    expect(getDiff({ cwd: repo })).not.toContain("new.ts");
    expect(untrackedFiles(repo)).toEqual([".gitignore", "new.ts"]);
    const files = parseDiffFiles(getDiff({ cwd: repo, includeUntracked: true }));
    const nf = files.find((f) => f.path === "new.ts");
    expect(nf?.status).toBe("added");
    expect(nf?.hunks[0]?.added).toBe(2);
    expect(files.some((f) => f.path === "ignored.txt")).toBe(false);
  });

  it("is rejected with --staged or --head", () => {
    expect(() => getDiff({ cwd: repo, staged: true, includeUntracked: true })).toThrow(/working-tree/);
    expect(() => getDiff({ cwd: repo, head: "HEAD", includeUntracked: true })).toThrow(/working-tree/);
  });
});

describe("fileSource", { timeout: 30_000 }, () => {
  it("reads the working tree, a ref, or null for missing files", () => {
    writeFileSync(join(repo, "b.txt"), "x\nwork\n");
    expect(fileSource({ cwd: repo })("b.txt")).toBe("x\nwork\n");
    expect(fileSource({ cwd: repo, head: "HEAD" })("b.txt")).toBe("x\n");
    expect(fileSource({ cwd: repo })("nope.txt")).toBeNull();
    sh(repo, "checkout", "--", "b.txt");
  });
});

describe("fileChurn", { timeout: 30_000 }, () => {
  it("counts commits and fix-like commits per path", () => {
    const c = fileChurn(["a.txt", "b.txt", "missing.txt"], 90, undefined, repo);
    expect(c["a.txt"]).toEqual({ commits: 3, fixCommits: 2 });
    expect(c["b.txt"]).toEqual({ commits: 1, fixCommits: 0 });
    expect(c["missing.txt"]).toEqual({ commits: 0, fixCommits: 0 });
  });

  it("returns zeros on a shallow clone", () => {
    const clone = mkdtempSync(join(tmpdir(), "tierview-shallow-"));
    sh(clone, "clone", "-q", "--depth", "1", `file://${repo.replace(/\\/g, "/")}`, ".");
    expect(fileChurn(["a.txt"], 90, undefined, clone)["a.txt"]).toEqual({ commits: 0, fixCommits: 0 });
  });

  it("returns zeros outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "tierview-norepo-"));
    expect(fileChurn(["a.txt"], 90, undefined, dir)["a.txt"]).toEqual({ commits: 0, fixCommits: 0 });
  });
});
