// NVIDIA-hosted DeepSeek-V4 provider — OpenAI-compatible /chat/completions with
// DeepSeek "thinking" (reasoning) mode. Powers catalog enrichment ("Push to Enrich").
// Pluggable per IModelProvider, so the model is a config change, not a code change.
//
// Uses native fetch (like OpenAIProvider) to avoid the 'openai' npm dependency.

import type {
  IModelProvider,
  ChatMessage,
  ModelUsage,
  ModelCompletionResult,
} from "./types.js";

/** Approximate pricing per 1M tokens (USD) — update periodically. */
const PRICING: Record<string, { input: number; output: number }> = {
  "deepseek-ai/deepseek-v4-flash": { input: 0.27, output: 1.1 },
  "deepseek-ai/deepseek-v4": { input: 0.55, output: 2.19 },
};

const DEFAULT_PRICING = { input: 0.5, output: 1.5 };

export interface NvidiaProviderConfig {
  apiKey: string;
  /** Override base URL. Default: https://integrate.api.nvidia.com/v1 */
  baseUrl?: string;
  /** Enable DeepSeek reasoning ("thinking") mode. Default: false. */
  thinking?: boolean;
  /** Reasoning effort when thinking is enabled. Default: "high". */
  reasoningEffort?: "low" | "medium" | "high";
}

export class NvidiaProvider implements IModelProvider {
  readonly providerName = "nvidia";
  private readonly config: NvidiaProviderConfig;

  constructor(config: NvidiaProviderConfig) {
    this.config = config;
  }

  async chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
  }): Promise<ModelCompletionResult> {
    const baseUrl =
      this.config.baseUrl?.replace(/\/+$/, "") ?? "https://integrate.api.nvidia.com/v1";
    const endpoint = `${baseUrl}/chat/completions`;
    const thinking = this.config.thinking ?? false;

    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      ...(params.jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(thinking
        ? {
            chat_template_kwargs: {
              thinking: true,
              reasoning_effort: this.config.reasoningEffort ?? "high",
            },
          }
        : {}),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NVIDIA API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string | null };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };
    const choice = data.choices?.[0];

    if (!choice?.message?.content) {
      throw new Error("NVIDIA returned empty response");
    }

    const result: ModelCompletionResult = {
      content: choice.message.content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      model: data.model ?? params.model,
      finishReason: choice.finish_reason ?? "unknown",
    };

    const reasoning = choice.message.reasoning_content;
    if (reasoning) result.reasoning = reasoning;

    return result;
  }

  estimateCost(model: string, usage: ModelUsage): number {
    const pricing = PRICING[model] ?? DEFAULT_PRICING;
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.completionTokens / 1_000_000) * pricing.output;
    return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
  }
}
