// Model provider interface — HLD §28: "model-router interface".
// Abstracts the LLM vendor so we can swap providers without
// changing extraction logic. Start with OpenAI, add others later.

/** A single chat message in the provider-agnostic format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Usage stats from a model completion. */
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Response from a model completion call. */
export interface ModelCompletionResult {
  content: string;
  usage: ModelUsage;
  model: string;
  finishReason: string;
}

/**
 * Contract every model provider must satisfy.
 * Implementations: OpenAIProvider, (future: AnthropicProvider, GeminiProvider).
 */
export interface IModelProvider {
  readonly providerName: string;

  /**
   * Send a chat completion request and return the response.
   * The response.content should be valid JSON when json_mode is requested.
   */
  chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
  }): Promise<ModelCompletionResult>;

  /**
   * Estimate cost in USD for a given model and token counts.
   * Used for the cost_ledger audit trail.
   */
  estimateCost(model: string, usage: ModelUsage): number;
}
