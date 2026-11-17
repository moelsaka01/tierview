// Phase 5: PR fetch, SARIF, summary comment, Action entry. All HTTP is mocked; no model or claude calls.
import Ajv from "ajv";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAction } from "../src/action";
import { runPr, runReview } from "../src/cli";
import { MARKER, renderComment, upsertComment } from "../src/github/comment";
import { type FetchLike, fetchPr, parsePrUrl, prefetchFiles } from "../src/github/pr";
import { reviewSarif } from "../src/output/sarif";
import type { Review } from "../src/types";
import { FakeBackend, finding } from "./fake-client";

const mixed = readFileSync("test/fixtures/mixed.diff", "utf8");
const LOGIN = "src/auth/login.py#1";

async function sampleReview(): Promise<Review> {
  const f = finding("src/auth/login.py", 1, { severity: "critical", category: "security", title: "SQL injection via f-string" });
  const f2 = finding("src/utils/format.ts", 3, { severity: "low", category: "maintainability", title: "Pipe | in title" });
  const b = new FakeBackend((req) => (req.tier === 3 ? { [LOGIN]: { verdict: "issues", findings: [f] } } : { "src/utils/format.ts#1": { verdict: "issues", findings: [f2] } }));
  let review!: Review;
  await runReview({}, { out: () => undefined, err: () => undefined, diff: mixed, backend: b, files: () => null, onReview: async (r) => void (review = r) });
  return review;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(routes: (c: Call) => { status?: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const c: Call = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
    calls.push(c);
    const r = routes(c) ?? { status: 404, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { f, calls };
}

const PR_URL = "https://github.com/acme/widgets/pull/42";
const prRoutes = (c: Call) => {
  if (c.url.endsWith("/pulls/42")) return c.headers.Accept === "application/vnd.github.diff" ? { body: mixed } : { body: { title: "Add login", body: "Adds SQL login", head: { sha: "abc123" } } };
  if (c.url.includes("/contents/")) return { body: "file contents\n" };
  return undefined;
};

describe("pr", () => {
  it("parses PR URLs and rejects anything else", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/pull/42")).toEqual({ owner: "acme", repo: "widgets", number: 42 });
    expect(parsePrUrl("github.com/a.b/c-d/pull/7/files#x").number).toBe(7);
    expect(() => parsePrUrl("https://github.com/acme/widgets/issues/42")).toThrow(/not a GitHub pull request URL/);
    expect(() => parsePrUrl("https://example.com/acme/widgets/pull/42")).toThrow();
  });

  it("fetches title, body, head sha and the diff, sending the token", async () => {
    const { f, calls } = mockFetch(prRoutes);
    const pr = await fetchPr(PR_URL, "tok", f);
    expect(pr).toMatchObject({ title: "Add login", body: "Adds SQL login", headSha: "abc123", diff: mixed });
    expect(calls.map((c) => c.headers.Accept)).toEqual(["application/vnd.github+json", "application/vnd.github.diff"]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  });

  it("explains a 404 and a 403", async () => {
    await expect(fetchPr(PR_URL, undefined, mockFetch(() => ({ status: 404, body: {} })).f)).rejects.toThrow(/set GITHUB_TOKEN/);
    await expect(fetchPr(PR_URL, "t", mockFetch(() => ({ status: 403, body: {} })).f)).rejects.toThrow(/permissions/);
  });

  it("prefetches file context from the contents API at the head sha; failures are null", async () => {
    const { f, calls } = mockFetch((c) => (c.url.includes("missing") ? { status: 404, body: {} } : prRoutes(c)));
    const src = await prefetchFiles({ owner: "acme", repo: "widgets", number: 42 }, "abc123", ["src/a b.ts", "src/missing.ts", "src/a b.ts"], "tok", f);
    expect(src("src/a b.ts")).toBe("file contents\n");
    expect(src("src/missing.ts")).toBeNull();
    expect(src("never/asked.ts")).toBeNull();
    expect(calls.filter((c) => c.url.includes("a%20b.ts")).length).toBe(1);
    expect(calls[0]!.url).toContain("ref=abc123");
  });

  it("`pr` reviews the fetched diff with the PR title shared, and the dry run posts nothing", async () => {
    const { f, calls } = mockFetch(prRoutes);
    const b = new FakeBackend(() => ({}));
    const out: string[] = [];
    expect(await runPr(PR_URL, {}, { out: (s) => out.push(s), err: () => undefined, backend: b }, f)).toBe(0);
    expect(out.join("")).toContain("Receipt");
    expect(b.requests[0]!.shared).toContain("Add login");
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(true);

    const out2: string[] = [];
    expect(await runPr(PR_URL, { dryRun: true }, { out: (s) => out2.push(s), err: () => undefined }, f)).toBe(0);
    expect(out2.join("")).toContain("dry run");
    expect(await runPr(PR_URL, { dryRun: true, comment: true }, { out: () => undefined, err: () => undefined }, f)).toBe(2);
  });
});

describe("sarif", () => {
  it("validates against the SARIF 2.1.0 schema and maps severity to level", async () => {
    const review = await sampleReview();
    expect(review.findings.length).toBe(2);
    const doc = JSON.parse(reviewSarif(review));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync("test/fixtures/sarif-2.1.0.schema.json", "utf8")));
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    const run = doc.runs[0];
    expect(run.tool.driver.name).toBe("tierview");
    const byRule = Object.fromEntries(run.results.map((r: { ruleId: string; level: string }) => [r.ruleId, r.level]));
    expect(byRule).toEqual({ security: "error", maintainability: "note" });
    expect(run.results[0].properties).toMatchObject({ tier: expect.any(Number), model: expect.any(String), confidence: expect.any(Number) });
  });

  it("an empty review is a valid SARIF with no results; --sarif writes the file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tv-")), "out.sarif");
    await runReview({ sarif: file }, { out: () => undefined, err: () => undefined, diff: mixed, backend: new FakeBackend(() => ({})), files: () => null });
    expect(JSON.parse(readFileSync(file, "utf8")).runs[0].results).toEqual([]);
  });
});

describe("comment", () => {
  it("renders findings and the receipt, escapes table cells, and carries the marker", async () => {
    const body = renderComment(await sampleReview());
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("2 finding(s)");
    expect(body).toContain("SQL injection via f-string");
    expect(body).toContain("### Cost receipt");
    expect(body).toContain("**Total $");
    expect(body).toContain("calculated, not measured");
  });

  it("creates a comment when none has the marker, updates the one that does", async () => {
    const ref = { owner: "acme", repo: "widgets", number: 42 };
    const created = mockFetch((c) => (c.method === "GET" ? { body: [{ id: 1, body: "unrelated" }] } : { body: { html_url: "https://x/new" } }));
    expect(await upsertComment(ref, `${MARKER} hi`, "t", created.f)).toEqual({ url: "https://x/new", updated: false });
    expect(created.calls.at(-1)).toMatchObject({ method: "POST" });
    expect(created.calls.at(-1)!.url).toMatch(/issues\/42\/comments$/);

    const updated = mockFetch((c) => (c.method === "GET" ? { body: [{ id: 1, body: "unrelated" }, { id: 9, body: `${MARKER} old` }] } : { body: { html_url: "https://x/9" } }));
    expect(await upsertComment(ref, `${MARKER} new`, "t", updated.f)).toEqual({ url: "https://x/9", updated: true });
    expect(updated.calls.at(-1)).toMatchObject({ method: "PATCH" });
    expect(updated.calls.at(-1)!.url).toMatch(/issues\/comments\/9$/);
  });

  it("`pr --comment` posts the summary after the review and needs a token", async () => {
    const saved = process.env.GITHUB_TOKEN;
    const savedGh = process.env.GH_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      const err: string[] = [];
      expect(await runPr(PR_URL, { comment: true }, { out: () => undefined, err: (s) => err.push(s) }, mockFetch(prRoutes).f)).toBe(2);
      expect(err.join("")).toContain("GITHUB_TOKEN");
      process.env.GITHUB_TOKEN = "tok";
      const m = mockFetch((c) => prRoutes(c) ?? (c.method === "GET" ? { body: [] } : { body: { html_url: "https://x/c" } }));
      expect(await runPr(PR_URL, { comment: true }, { out: () => undefined, err: () => undefined, backend: new FakeBackend(() => ({})) }, m.f)).toBe(0);
      expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).body).toContain(MARKER);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
      if (savedGh !== undefined) process.env.GH_TOKEN = savedGh;
    }
  });
});

describe("action", () => {
  const dir = mkdtempSync(join(tmpdir(), "tv-act-"));
  const event = join(dir, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { html_url: PR_URL } }));
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => out.push(s), err: () => undefined } };
  };

  it("skips quietly outside a PR, and without a key (fork PR), calling nothing", async () => {
    let called = false;
    const run = (async () => ((called = true), 0)) as never;
    const a = io();
    expect(await runAction({}, a.io, run)).toBe(0);
    const b = io();
    expect(await runAction({ GITHUB_EVENT_PATH: event }, b.io, run)).toBe(0);
    expect(b.out.join("")).toContain("no anthropic-api-key");
    expect(called).toBe(false);
  });

  it("uses the api backend, the key as a masked secret, a default cap of $2, and fails on --fail-on", async () => {
    const seen: { url?: string; opts?: Record<string, unknown> } = {};
    const run = (async (url: string, opts: Record<string, unknown>) => ((seen.url = url), (seen.opts = opts), 1)) as never;
    const a = io();
    const code = await runAction({ GITHUB_EVENT_PATH: event, "INPUT_ANTHROPIC-API-KEY": "sk-test", "INPUT_FAIL-ON": "high", "INPUT_GITHUB-TOKEN": "gh" }, a.io, run);
    expect(code).toBe(1);
    expect(seen.url).toBe(PR_URL);
    expect(seen.opts).toMatchObject({ backend: "api", maxCost: 2, failOn: "high", comment: true });
    expect(a.out.join("")).toContain("::add-mask::sk-test");
    expect(a.out.join("").replace("::add-mask::sk-test", "")).not.toContain("sk-test"); // never echoed except in the mask command
  });

  it("a budget stop is a warning, not a failed check; a bad max-cost is a usage error", async () => {
    const env = { GITHUB_EVENT_PATH: event, "INPUT_ANTHROPIC-API-KEY": "sk-test", "INPUT_MAX-COST": "0.5" };
    const a = io();
    expect(await runAction(env, a.io, (async () => 3) as never)).toBe(0);
    expect(a.out.join("")).toContain("::warning::");
    expect(await runAction({ ...env, "INPUT_MAX-COST": "abc" }, io().io, (async () => 0) as never)).toBe(2);
  });
});
