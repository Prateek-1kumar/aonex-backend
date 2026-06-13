// Cross-provider runtime fallback for enrichment.
//
// selectEnrichProvider picks ONE provider by availability, but if that provider
// fails mid-request (e.g. Gemini returns 429 "quota exceeded"), the request just
// dies. This wraps an ordered chain of (provider, model) links and, on a failure
// from one, transparently retries the SAME request on the next — so "Gemini
// primary, Groq fallback" actually fails over at runtime instead of just at boot.
//
// Each link uses its OWN model name (the incoming params.model is ignored), since
// gemini-2.0-flash and llama-3.3-70b are different names on different endpoints.

import type { ChatProvider } from "./chat-provider.js";

export interface ProviderModel {
  provider: ChatProvider;
  model: string;
  /** Short name for logs, e.g. "gemini" / "groq". */
  label?: string;
}

type ChatParams = Parameters<ChatProvider["chatCompletion"]>[0];
type ChatResult = Awaited<ReturnType<ChatProvider["chatCompletion"]>>;

export class FallbackChatProvider implements ChatProvider {
  constructor(private readonly chain: ProviderModel[]) {
    if (chain.length === 0) throw new Error("FallbackChatProvider needs at least one provider");
  }

  async chatCompletion(params: ChatParams): Promise<ChatResult> {
    let lastErr: unknown;
    for (let i = 0; i < this.chain.length; i++) {
      const link = this.chain[i]!;
      try {
        // Each provider already retries its own transient 429/5xx internally; if it
        // still throws, the provider is exhausted for this request → try the next.
        return await link.provider.chatCompletion({ ...params, model: link.model });
      } catch (err) {
        lastErr = err;
        const next = this.chain[i + 1];
        if (next) {
          // eslint-disable-next-line no-console
          console.warn(
            `[llm-fallback] ${link.label ?? link.model} failed (${String((err as Error).message).slice(0, 90)}); falling back to ${next.label ?? next.model}`
          );
        }
      }
    }
    throw lastErr;
  }

  estimateCost(model: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }): number {
    for (const link of this.chain) {
      if (link.provider.estimateCost) return link.provider.estimateCost(model, usage);
    }
    return 0;
  }
}
