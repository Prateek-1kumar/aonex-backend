// Text normalization for grounding + retrieval — re-exported from the shared
// kernel so the verifier and the RAG retriever (and every other text consumer
// in the repo) agree on what "the same token" means.

export {
  normalizeText,
  tokens,
  tokenSet,
  numerals,
  jaccard,
  valueToText,
} from "@aonex/lib-utils";
