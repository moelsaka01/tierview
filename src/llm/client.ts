// The `api` backend: the Anthropic SDK with a user-supplied ANTHROPIC_API_KEY. Spec: PLAN.md §0, §5, §5a.
// This is the only file that imports the Anthropic SDK.
//
// Request shape (§5): system = [tier prompt, shared context (+ cache_control)], one user message,
// output_config { effort, format: zodOutputFormat(TierResponse) }, no thinking param, no sampling params.
// Server-side refusal fallbacks are deliberately not enabled: escalation already re-sends a refused hunk to
// the next tier's model, and a server-side switch would change the model mid-request (see BUILD_LOG Phase 3).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { TierResponse, type ModelSubstitution, type Usage } from "../types";
import { BackendSetupError, type ModelUsage, type ReviewBackend, type ReviewRequest, type ReviewResult, addUsage, parseTierResponse } from "./backend";

/** The part of the SDK client this backend uses, so tests can inject a stub. */
export interface MessagesParser {
  messages: { parse: (params: never, options?: { maxRetries?: number }) => Promise<unknown> };
}

interface ParsedLike {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  parsed_output?: unknown;
  usage: Partial<Usage> & { input_tokens: number; output_tokens: number };
}

/** SDK error classes, re-exported so tests never import the SDK themselves. */
export const SdkErrors = {
  APIError: Anthropic.APIError,
  AuthenticationError: Anthropic.AuthenticationError,
  PermissionDeniedError: Anthropic.PermissionDeniedError,
  BadRequestError: Anthropic.BadRequestError,
  RateLimitError: Anthropic.RateLimitError,
  APIConnectionError: Anthropic.APIConnectionError,
  AnthropicError: Anthropic.AnthropicError,
};

export interface ApiBackendOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Test hook: a stub with messages.parse. */
  client?: MessagesParser;
  concurrency?: number;
  /** SDK retries for 408/409/429/5xx and connection errors. */
  maxRetries?: number;
}

const toUsage = (u: ParsedLike["usage"]): Usage => ({
  input_tokens: u.input_tokens ?? 0,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  output_tokens: u.output_tokens ?? 0,
});

export class ApiBackend implements ReviewBackend {
  readonly name = "api" as const;
  readonly concurrency: number;
  private readonly client: MessagesParser;
  private readonly format = zodOutputFormat(TierResponse);

  constructor(opts: ApiBackendOptions = {}) {
    this.concurrency = opts.concurrency ?? 4;
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new BackendSetupError("the api backend needs ANTHROPIC_API_KEY. Set it, or use --backend claude-code.");
    this.client = new Anthropic({ apiKey, maxRetries: opts.maxRetries ?? 2 }) as unknown as MessagesParser;
  }

  substitutions(): ModelSubstitution[] {
    return [];
  }

  params(req: ReviewRequest) {
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [
        { type: "text" as const, text: req.system },
        req.cache ? { type: "text" as const, text: req.shared, cache_control: { type: "ephemeral" as const } } : { type: "text" as const, text: req.shared },
      ],
      messages: [{ role: "user" as const, content: req.user }],
      output_config: { effort: req.effort, format: this.format },
    };
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    const usageByModel: Record<string, ModelUsage> = {};
    let calls = 0;
    let model = req.model;
    // One retry for parse failures only (§5). Transport errors are retried by the SDK.
    for (let attempt = 0; attempt < 2; attempt++) {
      let msg: ParsedLike;
      calls++;
      try {
        msg = (await this.client.messages.parse(this.params(req) as never)) as ParsedLike;
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
          throw new BackendSetupError(`Anthropic API rejected the key (${e.status}): ${e.message}`);
        }
        if (e instanceof Anthropic.APIError) {
          return { ok: false, reason: "error", detail: `API error ${e.status ?? "connection"}: ${e.message}`, model, usageByModel, calls };
        }
        if (e instanceof Anthropic.AnthropicError && attempt === 0) continue; // SDK could not parse the output
        if (e instanceof Anthropic.AnthropicError) return { ok: false, reason: "parse", detail: e.message, model, usageByModel, calls };
        throw e;
      }
      model = msg.model;
      addUsage(usageByModel, msg.model, toUsage(msg.usage));
      if (msg.stop_reason === "refusal") {
        const why = [msg.stop_details?.category, msg.stop_details?.explanation].filter(Boolean).join(": ");
        return { ok: false, reason: "refusal", detail: why || "refused", model, usageByModel, calls };
      }
      const parsed = parseTierResponse(msg.parsed_output);
      if (parsed) return { ok: true, response: parsed, model, usageByModel, calls };
      if (attempt === 1) {
        return { ok: false, reason: "parse", detail: `no valid structured output (stop_reason ${msg.stop_reason})`, model, usageByModel, calls };
      }
    }
    return { ok: false, reason: "parse", detail: "no valid structured output", model, usageByModel, calls };
  }
}
