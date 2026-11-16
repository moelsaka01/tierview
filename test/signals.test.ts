import { describe, expect, it } from "vitest";
import { buildDiffContext, categorySignals, fileKindOf, isTrivialHunk, structureSignals } from "../src/tier0/signals";
import type { FileKind, Hunk } from "../src/types";
import { cfg, hunk, rules } from "./helpers";

describe("fileKindOf", () => {
  it.each([
    ["package-lock.json", "generated"],
    ["web/dist/app.js", "generated"],
    ["src/api.pb.go", "generated"],
    ["README.md", "docs"],
    ["docs/guide.txt", "docs"],
    ["notes.txt", "docs"],
    ["requirements.txt", "source"],
    ["test/foo.ts", "test"],
    ["src/foo.test.ts", "test"],
    ["pkg/foo_test.go", "test"],
    ["package.json", "config"],
    ["Dockerfile", "config"],
    ["src/main.rs", "source"],
  ])("%s -> %s", (path, kind) => {
    expect(fileKindOf(path, rules)).toBe(kind);
  });
});

// [category, path, body lines that must fire, body lines that must not]
type Case = [string, string, string[], string[]];
const cases: Case[] = [
  ["secrets", "src/a.ts", ['+const apiKey = "abcdefgh12345";'], ["+const apiKey = process.env.KEY;"]],
  ["secrets", ".env.production", ["+X=1"], []],
  ["auth", "src/auth/guard.ts", ["+const a = 1;"], []],
  ["auth", "src/a.ts", ["+const t = jwt.sign(p);"], ["+const t = 1;"]],
  ["crypto", "src/a.py", ["+h = hashlib.md5(x)"], ["+h = hashlib.sha256(x)"]],
  ["crypto", "src/a.py", ["+requests.get(u, verify=False)"], []],
  ["payment", "src/billing/x.ts", ["+const a = 1;"], []],
  ["payment", "src/a.ts", ["+await stripe.charges.create(c);"], ["+await mail.send(c);"]],
  // Phase 4 (P4-09): a rewritten condition, a new bounds check, and allocation / lifetime calls.
  ["boundary", "src/a.c", ["-\tif (f & (A | B | C))", "+\tif (f & (A | C))"], ["-\tx = f(a);", "+\tx = g(a);"]],
  ["boundary", "src/a.c", ["+\t    addr <= base[i] + size[i]) {"], ["+\tVec<u8> v = Vec::new();", "+\tif (ready) {"]],
  ["boundary", "src/a.py", ["+    while i < len(items):"], ["+    for item in items:"]],
  ["memory", "src/a.c", ["+\tbuf = rte_zmalloc(NULL, n, 0);", "+\tmlx5_free(pool->name);"], ["+\tbuf = make_buffer(n);"]],
  ["memory", "src/a.rs", ["+    let p = Box::into_raw(b);"], ["+    let b = Box::new(1);"]],
  // Phase 4: the estimate.ts false positive, git checkout, and a budget Ledger class are not payment code.
  ["payment", "src/estimate.ts", ["+order.amount_cents -= refundCents;", "+const totalCents = a + b;"], ["+  const total = tiers.reduce((a, t) => a + t.cost_usd, 0);", "+    const price = priceFor(m.model, prices);", "+  run(`git checkout ${ref}`);", "+const ledger = new Ledger(x.maxCost);"]],
  ["sql", "src/a.py", ['+q = f"select * from t where id = {i}"'], ['+print("hello")']],
  ["sql", "src/a.js", ["+db.query(`SELECT * FROM t WHERE id = ${id}`)"], ["+db.query(stmt, [id])"]],
  ["migrations", "db/migrations/001_init.py", ["+x = 1"], []],
  ["deserialization", "src/a.py", ["+d = pickle.loads(b)"], ["+model.eval()", "+m = re.exec(s)"]],
  ["deserialization", "src/a.js", ["+eval(code)"], ["+r = rx.exec(s)"]],
  ["unsafe", "src/a.py", ["+subprocess.run(c, shell=True)"], ["+subprocess.run(c)"]],
  ["unsafe", "src/a.rs", ["+unsafe { *p = 1 }"], ["+let p = 1;"]],
  ["tests_weakened", "test/a.test.ts", ['+  it.skip("x", () => {});'], ['+  it("x", () => {});']],
  ["tests_weakened", "test/a.test.ts", ["-it('a', () => {", "-  expect(1).toBe(1);", "-});"], ["-  // note"]],
  ["permissions", "src/a.py", ["+if user.is_admin:"], ["+canvas.draw()"]],
  ["concurrency", "src/a.go", ["+  mu.Lock()"], ["+  x := 1"]],
  ["concurrency", "src/a.ts", ["+const r = await f();"], ["+const r = f();"]],
  ["error_handling_removed", "src/a.py", ["-    try:"], ["+    try:"]],
  ["error_handling_removed", "src/a.go", ["-if err != nil {"], ["+if err != nil {"]],
  ["infra", "Dockerfile", ["+RUN x"], []],
  ["infra", ".github/workflows/ci.yml", ["+x: 1"], []],
  ["assertions_removed", "test/a.test.ts", ["-  expect(a).toBe(1);"], [" expect(a).toBe(1);", "-  expect(a).toBe(1);", "+  expect(a).toBe(2);"]],
  ["dependencies", "package.json", ['+  "x": "1"'], []],
  ["dependencies", "requirements.txt", ["+requests==2"], []],
  ["boundary", "src/a.ts", ["-if (i < n) {", "+if (i <= n) {"], ["-const ok = i < n;", "+const ok = j < n;"]],
  ["boundary", "src/a.ts", ["-const x = a[i];", "+const x = a[i - 1];"], ["-const x = a[i];", "+const y = a[i];"]],
];

describe("category signals", () => {
  for (const [cat, path, fires, quiet] of cases) {
    const kind = fileKindOf(path, rules);
    it(`${cat} fires: ${path} ${fires[0]}`, () => {
      const r = categorySignals(hunk(path, fires), kind, rules);
      expect(r.map((x) => x.signal)).toContain(cat);
      expect(r.find((x) => x.signal === cat)?.weight).toBe(cfg.categories[cat]?.weight);
    });
    if (quiet.length) {
      it(`${cat} quiet: ${path} ${quiet[0]}`, () => {
        const r = categorySignals(hunk(path, quiet), kind, rules);
        expect(r.map((x) => x.signal)).not.toContain(cat);
      });
    }
  }

  it("fires deleted test file", () => {
    const h = hunk("test/a.test.ts", ["-x"], "deleted");
    expect(categorySignals(h, "test", rules).map((r) => r.signal)).toContain("tests_weakened");
  });

  it("counts a category once, however many patterns match", () => {
    const h = hunk("src/auth/login.ts", ["+const t = jwt.sign(p);", "+oauth.login(u);"]);
    expect(categorySignals(h, "source", rules).filter((r) => r.signal === "auth")).toHaveLength(1);
  });
});

describe("isTrivialHunk", () => {
  it("accepts comments, blank lines, import reordering and whitespace edits", () => {
    expect(isTrivialHunk(hunk("a.ts", ["-// old", "+// new"]))).toBe(true);
    expect(isTrivialHunk(hunk("a.ts", ["+", "-"]))).toBe(true);
    expect(isTrivialHunk(hunk("a.ts", ["-import b from 'b';", "-import a from 'a';", "+import a from 'a';", "+import b from 'b';"]))).toBe(true);
    expect(isTrivialHunk(hunk("a.ts", ["-const  a=1;", "+const a = 1;"]))).toBe(true);
  });
  it("rejects real changes", () => {
    expect(isTrivialHunk(hunk("a.ts", ["-const a = 1;", "+const a = 2;"]))).toBe(false);
    expect(isTrivialHunk(hunk("a.ts", ["+import c from 'c';"]))).toBe(false);
    expect(isTrivialHunk(hunk("a.ts", [" ctx"]))).toBe(false);
  });
});

describe("structure signals", () => {
  const ctxFor = (hunks: Hunk[], churn: Parameters<typeof buildDiffContext>[3] = null, weakened = false) => {
    const kinds = new Map<string, FileKind>(hunks.map((h) => [h.file, fileKindOf(h.file, rules)]));
    return { ctx: buildDiffContext(hunks, kinds, weakened, churn), kinds };
  };
  const names = (h: Hunk, hs: Hunk[], churn: Parameters<typeof buildDiffContext>[3] = null, weakened = false) => {
    const { ctx, kinds } = ctxFor(hs, churn, weakened);
    return structureSignals(h, kinds.get(h.file) as FileKind, ctx, cfg);
  };
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i}`);

  it("scores size buckets", () => {
    const pts = (n: number) => names(hunk("src/a.ts", lines(n)), [hunk("src/a.ts", lines(n))]).find((r) => r.signal === "size")?.weight ?? 0;
    expect([pts(5), pts(6), pts(30), pts(31), pts(100), pts(101)]).toEqual([0, 5, 5, 10, 10, 15]);
  });

  it("flags files with many hunks", () => {
    const hs = Array.from({ length: 6 }, (_, i) => hunk("src/a.ts", ["+x"], "modified", i + 1));
    expect(names(hs[0] as Hunk, hs).map((r) => r.signal)).toContain("many_hunks_in_file");
    expect(names(hs[0] as Hunk, hs.slice(0, 5)).map((r) => r.signal)).not.toContain("many_hunks_in_file");
  });

  it("flags deletion-only hunks", () => {
    const h = hunk("src/a.ts", ["-x"]);
    expect(names(h, [h]).map((r) => r.signal)).toContain("deletion_only");
  });

  it("uses churn and hotspot only when history is present", () => {
    const h = hunk("src/a.ts", ["+x"]);
    expect(names(h, [h], null).map((r) => r.signal)).not.toContain("churn");
    const s = names(h, [h], { "src/a.ts": { commits: 10, fixCommits: 2 } }).map((r) => r.signal);
    expect(s).toContain("churn");
    expect(s).toContain("hotspot");
    const q = names(h, [h], { "src/a.ts": { commits: 9, fixCommits: 1 } }).map((r) => r.signal);
    expect(q).not.toContain("churn");
    expect(q).not.toContain("hotspot");
  });

  it("flags scatter across files and directories, on source hunks only", () => {
    const wide = Array.from({ length: 9 }, (_, i) => hunk(`src/f${i}.ts`, ["+x"]));
    expect(names(wide[0] as Hunk, wide).map((r) => r.signal)).toContain("scatter");
    const dirs = ["a", "b", "c", "d"].map((d) => hunk(`${d}/x.ts`, ["+x"]));
    expect(names(dirs[0] as Hunk, dirs).map((r) => r.signal)).toContain("scatter");
    const docs = [...wide, hunk("README.md", ["+x"])];
    expect(names(docs.at(-1) as Hunk, docs).map((r) => r.signal)).not.toContain("scatter");
    const few = [hunk("src/a.ts", ["+x"]), hunk("lib/b.ts", ["+x"])];
    expect(names(few[0] as Hunk, few).map((r) => r.signal)).not.toContain("scatter");
  });

  it("adds diff-level points to source hunks when tests are weakened", () => {
    const h = hunk("src/a.ts", ["+x"]);
    expect(names(h, [h], null, true).map((r) => r.signal)).toContain("diff_weakens_tests");
    expect(names(h, [h], null, false).map((r) => r.signal)).not.toContain("diff_weakens_tests");
  });

  it("flags large source changes with no test file", () => {
    const h = hunk("src/a.ts", lines(51));
    expect(names(h, [h]).map((r) => r.signal)).toContain("no_tests_changed");
    const t = hunk("test/a.test.ts", ["+x"]);
    expect(names(h, [h, t]).map((r) => r.signal)).not.toContain("no_tests_changed");
    const small = hunk("src/a.ts", lines(50));
    expect(names(small, [small]).map((r) => r.signal)).not.toContain("no_tests_changed");
  });
});
