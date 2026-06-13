// Uses native fetch API to avoid requiring the 'openai' npm package,
// which prevents network-blocked installations from failing.

import type {
  IModelProvider,
  ChatMessage,
  ModelUsage,
  ModelCompletionResult,
} from "./types.js";

/** Approximate pricing per 1M tokens (USD) — updated periodically. */
const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
  // Groq (via baseUrl https://api.groq.com/openai/v1)
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "llama-3.2-90b-vision-preview": { input: 0.90, output: 0.90 },
  "llama-3.2-11b-vision-preview": { input: 0.18, output: 0.18 },
  // DeepSeek (via baseUrl https://api.deepseek.com/v1) — OpenAI-compatible.
  "deepseek-chat": { input: 0.27, output: 1.10 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 }
};

const DEFAULT_PRICING = { input: 1.0, output: 3.0 };

export interface OpenAIProviderConfig {
  apiKey: string;
  /** Override base URL for Azure OpenAI or compatible endpoints. */
  baseUrl?: string;
  /** Organization ID (optional). */
  organization?: string;
  /** Max retries on transient errors (HTTP 429 / 5xx). Default 4. */
  maxRetries?: number;
  /**
   * Models to try, in order, when the requested model is exhausted. Groq's
   * token-per-day (TPD) limits are PER-MODEL, so on a daily rate-limit we switch
   * to a fallback model (independent budget) instead of failing — keeping
   * enrichment/classification alive when the primary model's daily cap is hit.
   * e.g. ["llama-3.1-8b-instant"]. Empty = no fallback (prior behavior).
   */
  fallbackModels?: string[];
}

/** Transient HTTP statuses worth retrying (rate limit + upstream hiccups). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Never wait longer than this between attempts, even if the server asks. */
const MAX_RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retrying a transient error. Honors the standard
 * `Retry-After` header (seconds) first, then the provider's own message
 * (Groq: "Please try again in 12.965s"), then exponential backoff. Capped.
 */
function retryDelayMs(response: Response, body: string, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
  }
  const match = /try again in ([\d.]+)\s*s/i.exec(body);
  if (match) {
    const secs = Number(match[1]);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
  }
  // Exponential backoff: 1s, 2s, 4s, 8s … capped.
  return Math.min(2 ** attempt * 1000, MAX_RETRY_DELAY_MS);
}

export class OpenAIProvider implements IModelProvider {
  readonly providerName = "openai";
  private readonly config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
  }

  async chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
  }): Promise<ModelCompletionResult> {
    const baseUrl = this.config.baseUrl?.replace(/\/+$/, "") ?? "https://api.openai.com/v1";
    const endpoint = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }

    const maxRetries = this.config.maxRetries ?? 4;
    // The requested model first, then any fallbacks (deduped, primary excluded).
    const models = [params.model, ...(this.config.fallbackModels ?? [])].filter(
      (m, i, a) => m && a.indexOf(m) === i
    );
    let lastStatus = 0;
    let lastErrorText = "";

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi]!;
      const hasFallback = mi < models.length - 1;
      const body = {
        model,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        ...(params.jsonMode ? { response_format: { type: "json_object" } } : {}),
      };

      let switchModel = false;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
          };
          const choice = data.choices?.[0];
          if (!choice?.message?.content) {
            throw new Error("OpenAI returned empty response");
          }
          return {
            content: choice.message.content,
            usage: {
              promptTokens: data.usage?.prompt_tokens ?? 0,
              completionTokens: data.usage?.completion_tokens ?? 0,
              totalTokens: data.usage?.total_tokens ?? 0,
            },
            model: data.model ?? model,
            finishReason: choice.finish_reason ?? "unknown",
          };
        }

        lastStatus = response.status;
        lastErrorText = await response.text();

        // Hard error (400/401/404 …) — a fallback model won't help; surface it.
        if (!RETRYABLE_STATUS.has(response.status)) {
          throw new Error(`OpenAI API error (${response.status}): ${lastErrorText}`);
        }

        // A per-DAY token limit (Groq TPD) won't clear inside our retry window,
        // so don't burn ~2min retrying it — switch to a fallback model whose
        // daily budget is independent. Per-minute 429s / 5xx still back off.
        const dailyExhausted =
          response.status === 429 && /per day|\bTPD\b/i.test(lastErrorText);

        if (dailyExhausted || attempt >= maxRetries) {
          if (hasFallback) {
            console.warn(
              `[openai] ${model} ${dailyExhausted ? "daily-rate-limited" : `failed (${response.status})`}; falling back to ${models[mi + 1]}`
            );
            switchModel = true;
            break;
          }
          throw new Error(`OpenAI API error (${response.status}): ${lastErrorText}`);
        }

        const delay = retryDelayMs(response, lastErrorText, attempt) + Math.floor(Math.random() * 250);
        console.warn(
          `[openai] ${response.status} from ${model}; retry ${attempt + 1}/${maxRetries} in ${delay}ms`
        );
        await sleep(delay);
      }
      if (!switchModel) break;
    }

    // Unreachable (loop returns or throws), but satisfies the type checker.
    throw new Error(`OpenAI API error (${lastStatus}): ${lastErrorText}`);
  }

  estimateCost(model: string, usage: ModelUsage): number {
    const pricing = PRICING[model] ?? DEFAULT_PRICING;
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.completionTokens / 1_000_000) * pricing.output;
    return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
  }
}
