// Runtime cross-provider fallback: wraps an ordered chain of (provider, model)
// links and, when one throws, retries the same request on the next so failover
// happens mid-request, not just at boot. Each link uses its OWN model name; the
// incoming params.model is ignored since endpoints have different model names.

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
