// P3-01: both backends, with mocks only. No network, no real `claude` process.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendSetupError, type ReviewRequest } from "../src/llm/backend";
import { ClaudeCodeBackend, type RunResult, type Runner, buildArgs, normalizeModel, parseRun, readModelCache, resolveClaudeBinary, verifyClaudeBinary } from "../src/llm/claude-code";
import { ApiBackend, SdkErrors } from "../src/llm/client";
import { TierResponse } from "../src/types";
import { clean } from "./fake-client";
import { cfg } from "./helpers";

const T1 = cfg.models.tier1.model;
const T2 = cfg.models.tier2.model;
const T3 = cfg.models.tier3.model;
const req = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  tier: 1,
  model: T1,
  effort: "low",
  system: "SYSTEM",
  shared: "SHARED",
  user: "USER",
  hunkIds: ["a.ts#1"],
  cache: false,
  maxTokens: 16000,
  ...over,
});
const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const good = { reviews: [clean("a.ts#1")] };

describe("api backend (mocked SDK)", () => {
  const stub = (...replies: (object | Error)[]) => {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      client: {
        messages: {
          parse: async (p: never) => {
            calls.push(p as Record<string, unknown>);
            const r = replies.shift();
            if (r instanceof Error) throw r;
            return r;
          },
        },
      },
    };
  };
  const msg = (over: object = {}) => ({ model: T1, stop_reason: "end_turn", parsed_output: good, usage, ...over });

  it("refuses to start without ANTHROPIC_API_KEY", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new ApiBackend()).toThrow(BackendSetupError);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("sends effort, structured output, no thinking or sampling, and the cache marker on the shared context", async () => {
    const s = stub(msg());
    const r = await new ApiBackend({ client: s.client }).review(req({ cache: true }));
    expect(r.ok).toBe(true);
    const p = s.calls[0]!;
    expect(p.model).toBe(T1);
    expect((p.output_config as { effort: string }).effort).toBe("low");
    expect((p.output_config as { format: unknown }).format).toBeTruthy();
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
    const sys = p.system as { text: string; cache_control?: unknown }[];
    expect(sys.map((b) => b.text)).toEqual(["SYSTEM", "SHARED"]);
    expect(sys[0]!.cache_control).toBeUndefined();
    expect(sys[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(r.usageByModel[T1]!.usage.input_tokens).toBe(100);
  });

  it("omits the cache marker when caching is off", async () => {
    const s = stub(msg());
    await new ApiBackend({ client: s.client }).review(req());
    expect((s.calls[0]!.system as { cache_control?: unknown }[])[1]!.cache_control).toBeUndefined();
  });

  it("reports refusals with their category, without retrying", async () => {
    const s = stub(msg({ stop_reason: "refusal", parsed_output: null, stop_details: { category: "cyber", explanation: "x" } }));
    const r = await new ApiBackend({ client: s.client }).review(req());
    expect(r).toMatchObject({ ok: false, reason: "refusal", detail: "cyber: x", calls: 1 });
  });

  it("retries a parse failure once and adds up usage", async () => {
    const s = stub(msg({ parsed_output: null }), msg());
    const r = await new ApiBackend({ client: s.client }).review(req());
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(2);
    expect(r.usageByModel[T1]!.usage.output_tokens).toBe(40);
    const s2 = stub(msg({ parsed_output: null }), msg({ parsed_output: { nope: 1 } }));
    expect(await new ApiBackend({ client: s2.client }).review(req())).toMatchObject({ ok: false, reason: "parse", calls: 2 });
  });

  it("costs the model the response names", async () => {
    const s = stub(msg({ model: T2 }));
    const r = await new ApiBackend({ client: s.client }).review(req());
    expect(r.model).toBe(T2);
    expect(Object.keys(r.usageByModel)).toEqual([T2]);
  });

  it("maps typed SDK errors: auth is fatal, others fail the request", async () => {
    const auth = new SdkErrors.AuthenticationError(401, {}, "bad key", new Headers());
    await expect(new ApiBackend({ client: stub(auth).client }).review(req())).rejects.toBeInstanceOf(BackendSetupError);
    const bad = new SdkErrors.BadRequestError(400, {}, "zero retention", new Headers());
    expect(await new ApiBackend({ client: stub(bad).client }).review(req())).toMatchObject({ ok: false, reason: "error" });
    const conn = new SdkErrors.APIConnectionError({ message: "down" });
    expect(await new ApiBackend({ client: stub(conn).client }).review(req())).toMatchObject({ ok: false, reason: "error" });
  });
});

// ---- claude-code -----------------------------------------------------------

const cliJson = (over: object = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: good,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: { [T1]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 300, cacheCreationInputTokens: 50, costUSD: 0.001 } },
    total_cost_usd: 0.001,
    ...over,
  });

function fakeRunner(...outs: (string | RunResult)[]) {
  const seen: { args: string[]; stdin: string; cwd: string; system: string }[] = [];
  const run: Runner = async (_bin, args, stdin, opts) => {
    const f = args[args.indexOf("--system-prompt-file") + 1];
    seen.push({ args, stdin, cwd: opts.cwd, system: f && args.includes("--system-prompt-file") ? readFileSync(f, "utf8") : "" });
    const o = outs.shift() ?? cliJson();
    return typeof o === "string" ? { code: 0, stdout: o, stderr: "" } : o;
  };
  return { run, seen };
}

describe("claude-code backend (fake runner)", () => {
  it("builds a non-interactive call with the tier's model, effort, schema and no tools", () => {
    const a = buildArgs({ effort: "high" }, T3, "/tmp/s.txt", T2);
    const val = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a[0]).toBe("-p");
    expect(val("--output-format")).toBe("json");
    expect(val("--model")).toBe(T3);
    expect(val("--effort")).toBe("high");
    expect(val("--tools")).toBe("");
    expect(val("--fallback-model")).toBe(T2);
    expect(a).toContain("--no-session-persistence");
    expect(a).toContain("--safe-mode");
    const schema = JSON.parse(val("--json-schema")!);
    expect(schema.properties.reviews.type).toBe("array");
    expect(buildArgs({ effort: "low" }, T2, "/s", T2)).not.toContain("--fallback-model");
    // structured outputs reject numeric ranges; zod 4 adds safe-integer bounds to .int()
    expect(val("--json-schema")).not.toMatch(/minimum|maximum|\$schema/);
    expect(schema.properties.reviews.items.properties.findings.items.properties.start_line.type).toBe("integer");
  });

  it("parses structured_output and per-model usage including cache tokens", async () => {
    const f = fakeRunner(cliJson());
    const r = await new ClaudeCodeBackend({ bin: "claude", run: f.run, cachePath: null }).review(req());
    expect(r.ok && TierResponse.parse(r.response)).toBeTruthy();
    expect(r.usageByModel[T1]!.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 });
    expect(f.seen[0]!.stdin).toBe("USER");
    expect(f.seen[0]!.system).toBe("SYSTEM\n\nSHARED");
    expect(f.seen[0]!.cwd).toContain("tierview-cc-");
  });

  it("detects a Tier 3 fallback from modelUsage, reports it, and asks for the fallback directly next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tierview-cache-"));
    const cachePath = join(dir, "m.json");
    const ranOpus = cliJson({ modelUsage: { [`${T2}[1m]`]: { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } });
    const f = fakeRunner(ranOpus, ranOpus);
    const cc = new ClaudeCodeBackend({ bin: "claude", run: f.run, cachePath });
    const r = await cc.review(req({ tier: 3, model: T3, effort: "high", fallbackModel: T2 }));
    expect(r.model).toBe(T2);
    expect(cc.substitutions()).toEqual([expect.objectContaining({ tier: 3, requested: T3, used: T2 })]);
    await cc.review(req({ tier: 3, model: T3, effort: "high", fallbackModel: T2 }));
    const second = f.seen[1]!.args;
    expect(second[second.indexOf("--model") + 1]).toBe(T2);
    expect(readModelCache(cachePath)[T3]!.used).toBe(T2);
    // A new run reads the cache and goes straight to the fallback.
    const f2 = fakeRunner(ranOpus);
    const cc2 = new ClaudeCodeBackend({ bin: "claude", run: f2.run, cachePath });
    await cc2.review(req({ tier: 3, model: T3, effort: "high", fallbackModel: T2 }));
    expect(f2.seen[0]!.args[f2.seen[0]!.args.indexOf("--model") + 1]).toBe(T2);
    expect(cc2.substitutions()[0]!.reason).toMatch(/^cached detection/);
  });

  it("retries on the fallback model when the requested model errors", async () => {
    const err = cliJson({ is_error: true, subtype: "error_during_execution", result: "There's an issue with the selected model", structured_output: undefined, modelUsage: {} });
    const ok = cliJson({ modelUsage: { [T2]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
    const f = fakeRunner(err, ok);
    const cc = new ClaudeCodeBackend({ bin: "claude", run: f.run, cachePath: null });
    const r = await cc.review(req({ tier: 3, model: T3, fallbackModel: T2 }));
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(2);
    expect(cc.substitutions()[0]!.used).toBe(T2);
  });

  it("retries a missing structured_output once, then fails as parse", async () => {
    const none = cliJson({ structured_output: undefined });
    const f = fakeRunner(none, none);
    expect(await new ClaudeCodeBackend({ bin: "claude", run: f.run, cachePath: null }).review(req())).toMatchObject({ ok: false, reason: "parse", calls: 2 });
  });

  it("handles a crash or garbage output", () => {
    expect(parseRun({ code: 1, stdout: "", stderr: "boom" }, T1)).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
    expect(parseRun({ code: null, stdout: "", stderr: "", timedOut: true }, T1).error).toContain("timed out");
    expect(normalizeModel(`${T2}[1m]`)).toBe(T2);
  });

  it("finds the binary: env override, PATH, then ~/.local/bin; never a .cmd shim", () => {
    const has = (set: string[]) => (p: string) => set.includes(p.replace(/\\/g, "/"));
    expect(resolveClaudeBinary({ env: { TIERVIEW_CLAUDE_BIN: "/x/claude" }, exists: has(["/x/claude"]) })).toBe("/x/claude");
    expect(resolveClaudeBinary({ env: { PATH: "/a:/b" }, platform: "linux", exists: has(["/b/claude"]) })?.replace(/\\/g, "/")).toBe("/b/claude");
    expect(resolveClaudeBinary({ env: { PATH: "C:/npm" }, platform: "win32", home: "C:/u", exists: has(["C:/npm/claude.cmd", "C:/u/.local/bin/claude.exe"]) })?.replace(/\\/g, "/")).toBe("C:/u/.local/bin/claude.exe");
    expect(resolveClaudeBinary({ env: {}, home: "/h", exists: () => false })).toBeNull();
  });

  it("verifies the binary is Claude Code before using it", async () => {
    const ok: Runner = async () => ({ code: 0, stdout: "2.1.322 (Claude Code)\n", stderr: "" });
    const other: Runner = async () => ({ code: 0, stdout: "claude 1.0 (something else)\n", stderr: "" });
    expect(await verifyClaudeBinary("claude", ok)).toContain("Claude Code");
    await expect(verifyClaudeBinary("claude", other)).rejects.toBeInstanceOf(BackendSetupError);
  });

  it("ignores stale detection cache entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tierview-cache-"));
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify({ version: 1, models: { [T3]: { used: T2, checked: "2026-01-01T00:00:00Z", reason: "x" } } }));
    expect(readModelCache(p, new Date("2026-11-16"))).toEqual({});
    expect(readModelCache(p, new Date("2026-01-03"))[T3]!.used).toBe(T2);
  });
});

describe("claude-code result recorded from a live call (P3-10)", () => {
  const stdout = readFileSync("test/fixtures/claude-result-tier1.json", "utf8");

  it("parses it and prices 1-hour cache writes like Claude Code does", async () => {
    const { costOfModels, loadPrices } = await import("../src/prices");
    const p = parseRun({ code: 0, stdout, stderr: "" }, T1);
    expect(p.ok).toBe(true);
    expect(p.dominant).toBe(T1);
    expect(p.usageByModel[T1]!.usage.cache_creation_1h_input_tokens).toBe(3096);
    expect(TierResponse.parse(p.structured).reviews[0]!.findings[0]!.severity).toBe("high");
    const reported = JSON.parse(stdout).modelUsage[T1].costUSD as number;
    expect(costOfModels(p.usageByModel, loadPrices()).cost).toBeCloseTo(reported, 6);
  });
});
