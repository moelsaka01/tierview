// The `claude-code` backend: runs the official Claude Code CLI in non-interactive mode. Spec: PLAN.md §5a.
//
//   claude -p --output-format json --json-schema <TierResponse> --model <id> --effort <level>
//          --tools "" --system-prompt-file <tmp> --no-session-persistence --disable-slash-commands
//          --strict-mcp-config --safe-mode [--fallback-model <tier-2 model>]      (prompt on stdin)
//
// Flags checked against `claude --help` (v2.1.322) and code.claude.com/docs/en/{cli-reference,headless} on 2026-11-16.
// The process runs in an empty temp directory with --safe-mode so the reviewed repo's CLAUDE.md, hooks, MCP
// servers and plugins never load (a `-p` run skips the workspace trust dialog).
// tierview only ever executes the binary; it never reads, copies or reuses Claude Code's credentials.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type LlmTier, type ModelSubstitution, TierResponse, type Usage } from "../types";
import { FABLE_NOT_ENABLED, isFable } from "../fable";
import { BackendSetupError, type ModelUsage, type ReviewBackend, type ReviewRequest, type ReviewResult, addUsage, parseTierResponse } from "./backend";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type Runner = (bin: string, args: string[], stdin: string, opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

export const runProcess: Runner = (bin, args, stdin, opts) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(stdin, "utf8");
  });

// ---- Locating the official binary ------------------------------------------

export interface ResolveOptions {
  configured?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (p: string) => boolean;
}

/**
 * Where to find `claude`: TIERVIEW_CLAUDE_BIN, then the config's backend.claude_code.binary, then PATH,
 * then the native installer's location (~/.local/bin). Only native executables: on Windows an npm `claude.cmd`
 * shim would need a shell, which would mangle the JSON schema argument.
 */
export function resolveClaudeBinary(o: ResolveOptions = {}): string | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const explicit = env.TIERVIEW_CLAUDE_BIN || o.configured;
  if (explicit) return exists(explicit) ? explicit : null;
  const name = platform === "win32" ? "claude.exe" : "claude";
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? env.Path ?? "").split(sep).filter(Boolean)) {
    const p = join(dir, name);
    if (exists(p)) return p;
  }
  const local = join(o.home ?? homedir(), ".local", "bin", name);
  return exists(local) ? local : null;
}

// ---- Parsing the result -----------------------------------------------------

const ModelUsageEntry = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadInputTokens: z.number().default(0),
  cacheCreationInputTokens: z.number().default(0),
  cacheCreationEphemeral1hInputTokens: z.number().default(0),
  costUSD: z.number().optional(),
});
const CliResult = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
    })
    .partial()
    .optional(),
  modelUsage: z.record(z.string(), ModelUsageEntry).optional(),
  total_cost_usd: z.number().optional(),
});
export type CliResult = z.infer<typeof CliResult>;

/** "claude-opus-5-5[1m]" -> "claude-opus-5-5". */
export const normalizeModel = (m: string) => m.replace(/\[[^\]]*\]$/, "").trim();

export interface ParsedRun {
  ok: boolean;
  structured: unknown;
  refusal: boolean;
  error: string | null;
  usageByModel: Record<string, ModelUsage>;
  /** The model with the most output tokens, or null when no usage was reported. */
  dominant: string | null;
}

export function parseRun(run: RunResult, requested: string): ParsedRun {
  const usageByModel: Record<string, ModelUsage> = {};
  let json: CliResult | null = null;
  const text = run.stdout.trim();
  const last = text.lastIndexOf("\n{");
  for (const candidate of [text, last >= 0 ? text.slice(last + 1) : ""]) {
    if (!candidate) continue;
    try {
      const r = CliResult.safeParse(JSON.parse(candidate));
      if (r.success) {
        json = r.data;
        break;
      }
    } catch {
      /* not JSON */
    }
  }
  if (!json) {
    const why = run.timedOut ? "timed out" : `exit ${run.code}: ${(run.stderr || run.stdout).trim().slice(0, 400) || "no output"}`;
    return { ok: false, structured: undefined, refusal: false, error: `claude produced no JSON result (${why})`, usageByModel, dominant: null };
  }
  if (json.modelUsage && Object.keys(json.modelUsage).length) {
    for (const [m, u] of Object.entries(json.modelUsage)) {
      const usage: Usage = { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens, cache_creation_1h_input_tokens: u.cacheCreationEphemeral1hInputTokens };
      addUsage(usageByModel, normalizeModel(m), usage, u.costUSD);
    }
  } else if (json.usage) {
    const u = json.usage;
    addUsage(usageByModel, requested, { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 }, json.total_cost_usd);
  }
  let dominant: string | null = null;
  let best = -1;
  for (const [m, u] of Object.entries(usageByModel)) {
    const score = u.usage.output_tokens * 1e6 + u.usage.input_tokens + u.usage.cache_read_input_tokens + u.usage.cache_creation_input_tokens;
    if (score > best) {
      best = score;
      dominant = m;
    }
  }
  const error = json.is_error || (json.subtype && json.subtype !== "success") ? `${json.subtype ?? "error"}: ${(json.result ?? "").slice(0, 400)}` : null;
  const refusal = json.stop_reason === "refusal";
  return { ok: !error && json.structured_output !== undefined, structured: json.structured_output, refusal, error, usageByModel, dominant };
}

const MODEL_PROBLEM = /model|not available|not found|restricted|usage credits|access/i;

// ---- Detection cache --------------------------------------------------------

const CacheFile = z.object({
  version: z.literal(1),
  models: z.record(z.string(), z.object({ used: z.string(), checked: z.string(), reason: z.string() })),
});
type CacheFile = z.infer<typeof CacheFile>;
export const CACHE_MAX_AGE_DAYS = 7;

export function defaultCachePath(home = homedir()): string {
  return join(home, ".tierview", "claude-code-models.json");
}

export function readModelCache(path: string, now = new Date()): CacheFile["models"] {
  try {
    const parsed = CacheFile.parse(JSON.parse(readFileSync(path, "utf8")));
    const fresh: CacheFile["models"] = {};
    for (const [k, v] of Object.entries(parsed.models)) {
      if ((now.getTime() - Date.parse(v.checked)) / 864e5 <= CACHE_MAX_AGE_DAYS) fresh[k] = v;
    }
    return fresh;
  } catch {
    return {};
  }
}

export function writeModelCache(path: string, models: CacheFile["models"]): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, models }, null, 2) + "\n");
  } catch {
    /* the cache is an optimisation */
  }
}

// ---- The backend --------------------------------------------------------------

export interface ClaudeCodeOptions {
  bin: string;
  timeoutMs?: number;
  run?: Runner;
  /** null disables the detection cache (tests). */
  cachePath?: string | null;
  now?: () => Date;
  /** Fable is opt-in (PLAN §5a). Without it, this backend never starts a `claude` process for a Fable model. */
  allowFable?: boolean;
}

/** Keywords structured outputs cannot express (§0). zod 4 adds safe-integer bounds to .int(), so strip them. */
const UNSUPPORTED = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength"]);
export function cleanSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanSchema);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, x]) => [k, cleanSchema(x)]));
  return v;
}

export const SCHEMA_JSON = JSON.stringify(cleanSchema(z.toJSONSchema(TierResponse)));

export function buildArgs(req: Pick<ReviewRequest, "effort">, model: string, systemFile: string, fallbackModel?: string): string[] {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", SCHEMA_JSON,
    "--model", model,
    "--effort", req.effort,
    "--tools", "",
    "--system-prompt-file", systemFile,
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--safe-mode",
  ];
  if (fallbackModel && fallbackModel !== model) args.push("--fallback-model", fallbackModel);
  return args;
}

/** Verifies the binary is Claude Code (`claude --version` prints "<version> (Claude Code)"). */
export async function verifyClaudeBinary(bin: string, run: Runner = runProcess): Promise<string> {
  const r = await run(bin, ["--version"], "", { cwd: tmpdir(), timeoutMs: 30_000 });
  const line = r.stdout.trim().split("\n")[0] ?? "";
  if (r.code !== 0 || !/\(Claude Code\)/.test(line)) {
    throw new BackendSetupError(`${bin} does not look like the official Claude Code CLI (\`--version\` printed "${line || r.stderr.trim()}").`);
  }
  return line;
}

export class ClaudeCodeBackend implements ReviewBackend {
  readonly name = "claude-code" as const;
  readonly concurrency = 1;
  private readonly run: Runner;
  private readonly timeoutMs: number;
  private readonly resolved = new Map<string, string>();
  private readonly subs: ModelSubstitution[] = [];
  private readonly cache: CacheFile["models"];
  private readonly now: () => Date;

  constructor(private readonly opts: ClaudeCodeOptions) {
    this.run = opts.run ?? runProcess;
    this.timeoutMs = opts.timeoutMs ?? 900_000;
    this.now = opts.now ?? (() => new Date());
    this.cache = opts.cachePath ? readModelCache(opts.cachePath, this.now()) : {};
    for (const [requested, v] of Object.entries(this.cache)) if (v.used !== requested) this.resolved.set(requested, v.used);
  }

  substitutions(): ModelSubstitution[] {
    return [...this.subs];
  }

  private note(tier: LlmTier, requested: string, used: string, reason: string, persist: boolean): void {
    this.resolved.set(requested, used);
    if (!this.subs.some((s) => s.tier === tier && s.requested === requested)) this.subs.push({ tier, requested, used, reason });
    if (persist && this.opts.cachePath) {
      this.cache[requested] = { used, checked: this.now().toISOString(), reason };
      writeModelCache(this.opts.cachePath, this.cache);
    }
  }

  private async once(req: ReviewRequest, model: string): Promise<{ parsed: ParsedRun; fallbackUsed: boolean }> {
    if (!this.opts.allowFable && (isFable(model) || (req.fallbackModel !== undefined && isFable(req.fallbackModel)))) {
      throw new BackendSetupError(`refusing to request ${model} through Claude Code: ${FABLE_NOT_ENABLED} (pass --allow-fable).`);
    }
    const dir = mkdtempSync(join(tmpdir(), "tierview-cc-"));
    try {
      const systemFile = join(dir, "system.txt");
      writeFileSync(systemFile, `${req.system}\n\n${req.shared}`);
      const run = await this.run(this.opts.bin, buildArgs(req, model, systemFile, req.fallbackModel), req.user, { cwd: dir, timeoutMs: this.timeoutMs });
      const parsed = parseRun(run, model);
      const debugDir = process.env.TIERVIEW_DEBUG_DIR;
      if (debugDir) {
        mkdirSync(debugDir, { recursive: true });
        const stamp = `${Date.now()}-t${req.tier}`;
        writeFileSync(join(debugDir, `${stamp}.json`), JSON.stringify({ args: buildArgs(req, model, "<system file>", req.fallbackModel), code: run.code, timedOut: run.timedOut ?? false, stdout: run.stdout, stderr: run.stderr }, null, 2));
      }
      return { parsed, fallbackUsed: !!req.fallbackModel && parsed.dominant === req.fallbackModel && model !== req.fallbackModel };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    const usageByModel: Record<string, ModelUsage> = {};
    let calls = 0;
    let model = this.resolved.get(req.model) ?? req.model;
    if (!this.opts.allowFable && isFable(model)) {
      return { ok: false, reason: "error", detail: `${FABLE_NOT_ENABLED}: pass --allow-fable or set allowFable: true`, model, usageByModel, calls };
    }
    if (!this.opts.allowFable && req.fallbackModel !== undefined && isFable(req.fallbackModel)) req = { ...req, fallbackModel: undefined };
    const cached = this.cache[req.model];
    if (cached && cached.used !== req.model) this.note(req.tier, req.model, cached.used, `cached detection from ${cached.checked.slice(0, 10)}: ${cached.reason}`, false);

    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      const { parsed } = await this.once(req, model);
      for (const [m, u] of Object.entries(parsed.usageByModel)) addUsage(usageByModel, m, u.usage, u.reportedCostUsd);
      const used = parsed.dominant ?? model;

      // The requested model did not run: an unavailable model, a plan restriction, or --fallback-model kicked in.
      if (parsed.dominant && parsed.dominant !== model) {
        this.note(req.tier, req.model, parsed.dominant, `Claude Code ran ${parsed.dominant} when asked for ${model} (not available on this plan or overloaded)`, true);
        model = parsed.dominant;
      } else if (parsed.error && req.fallbackModel && model !== req.fallbackModel && MODEL_PROBLEM.test(parsed.error)) {
        this.note(req.tier, req.model, req.fallbackModel, `${model} failed: ${parsed.error.slice(0, 160)}`, true);
        model = req.fallbackModel;
        attempt--; // switching models is not a parse retry
        if (calls > 3) break;
        continue;
      } else if (!this.cache[req.model] && parsed.dominant === req.model && this.opts.cachePath) {
        this.cache[req.model] = { used: req.model, checked: this.now().toISOString(), reason: "ran as requested" };
        writeModelCache(this.opts.cachePath, this.cache);
      }

      if (parsed.refusal) return { ok: false, reason: "refusal", detail: "refused", model: used, usageByModel, calls };
      if (parsed.error) return { ok: false, reason: "error", detail: parsed.error, model: used, usageByModel, calls };
      const response = parseTierResponse(parsed.structured);
      if (response) return { ok: true, response, model: used, usageByModel, calls };
      if (attempt === 1) return { ok: false, reason: "parse", detail: "no valid structured_output in the claude result", model: used, usageByModel, calls };
    }
    return { ok: false, reason: "error", detail: "claude call failed", model, usageByModel, calls };
  }

  /**
   * Explicit detection (`tierview models --probe`): one tiny call per model. Records which model actually ran.
   * Note: on some plans Fable bills usage credits, and `claude -p` does not ask before billing them.
   */
  async probe(models: string[]): Promise<{ model: string; used: string | null; error: string | null }[]> {
    const out: { model: string; used: string | null; error: string | null }[] = [];
    for (const m of models) {
      if (!this.opts.allowFable && isFable(m)) {
        out.push({ model: m, used: null, error: `not probed: ${FABLE_NOT_ENABLED} (pass --allow-fable)` });
        continue;
      }
      const dir = mkdtempSync(join(tmpdir(), "tierview-cc-"));
      try {
        const args = ["-p", "--output-format", "json", "--model", m, "--effort", "low", "--tools", "", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--safe-mode"];
        const run = await this.run(this.opts.bin, args, "Reply with the single word: ok", { cwd: dir, timeoutMs: 120_000 });
        const p = parseRun(run, m);
        const used = p.dominant;
        out.push({ model: m, used, error: p.error });
        if (used && this.opts.cachePath) {
          this.cache[m] = { used, checked: this.now().toISOString(), reason: used === m ? "probe: available" : `probe: Claude Code ran ${used}` };
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (this.opts.cachePath) writeModelCache(this.opts.cachePath, this.cache);
    return out;
  }
}
