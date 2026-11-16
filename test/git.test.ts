import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fileChurn, getDiff } from "../src/git";

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
});

describe("getDiff", () => {
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

describe("fileChurn", () => {
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
