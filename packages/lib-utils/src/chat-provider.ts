// The minimal shared chat-provider contract for provider-injected LLM callers
// (taxonomy-classifier's resolver, taxonomy-enrichment's engine).
//
// Structurally compatible with @aonex/ingestion-llm-extractor's IModelProvider:
// any IModelProvider satisfies ChatProvider, and a caller that only needs
// `content` can ignore the optional fields. Kept here (dependency-free) so the
// pure taxonomy packages don't have to depend on the extractor package.

export interface ChatProvider {
  chatCompletion(params: {
    model: string;
    messages: { role: "system" | "user"; content: string }[];
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
  }): Promise<{
    content: string;
    model?: string;
    usage?: { promptTokens: number; completionTokens: number };
  }>;
  estimateCost?(
    model: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  ): number;
}
