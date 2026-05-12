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
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
};

const DEFAULT_PRICING = { input: 1.0, output: 3.0 };

export interface OpenAIProviderConfig {
  apiKey: string;
  /** Override base URL for Azure OpenAI or compatible endpoints. */
  baseUrl?: string;
  /** Organization ID (optional). */
  organization?: string;
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

    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      ...(params.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
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
      model: data.model ?? params.model,
      finishReason: choice.finish_reason ?? "unknown",
    };
  }

  estimateCost(model: string, usage: ModelUsage): number {
    const pricing = PRICING[model] ?? DEFAULT_PRICING;
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.completionTokens / 1_000_000) * pricing.output;
    return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
  }
}
