// Model router — factory for creating the correct provider based
// on configuration. HLD §28: "model-router interface".
// Currently supports OpenAI only; add new providers here.

import type { IModelProvider } from "./providers/types.js";
import { OpenAIProvider, type OpenAIProviderConfig } from "./providers/openai.js";

export type ModelProviderConfig =
  | { provider: "openai"; config: OpenAIProviderConfig };
  // Future: | { provider: "anthropic"; config: AnthropicProviderConfig }
  // Future: | { provider: "gemini"; config: GeminiProviderConfig }

/**
 * Create a model provider instance from configuration.
 * This is the only entry point for obtaining an IModelProvider —
 * callers never instantiate provider classes directly.
 */
export function createModelProvider(settings: ModelProviderConfig): IModelProvider {
  if (settings.provider === "openai") {
    return new OpenAIProvider(settings.config);
  }
  // Exhaustiveness: if new providers are added to the union, TS will
  // error here because settings.provider will not be 'never' anymore.
  throw new Error(`Unknown model provider: ${(settings as { provider: string }).provider}`);
}
