// @aonex/taxonomy-classifier — resolve product signals to a canonical node.

export { classify, buildIndex, tokenize, normLabel } from "./classify.js";
export { classifyWithFallback } from "./fallback.js";
export { deterministicResolver, llmResolver, type ChatProvider } from "./resolver.js";
export type {
  ProductSignals,
  LeafEntry,
  ClassifierIndex,
  Candidate,
  ClassifyMethod,
  ClassifyResult,
  ClassifyOptions,
  ClassifierResolver,
  ResolverInput,
  ResolverDecision,
  FallbackOutcome,
  FallbackResult,
  FallbackOptions,
} from "./types.js";
