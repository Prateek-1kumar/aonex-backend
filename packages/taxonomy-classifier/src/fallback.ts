// Two-stage classify: deterministic (alias+lexical) -> pluggable resolver.
// High-confidence deterministic results auto-assign and skip the resolver;
// everything else goes to the resolver, which assigns / proposes a new node /
// abstains. Abstain + propose_node route to the Lab (P1.4).

import { classify } from "./classify.js";
import type {
  ClassifierIndex,
  ClassifierResolver,
  FallbackOptions,
  FallbackResult,
  ProductSignals,
  ResolverInput,
} from "./types.js";

function buildResolverInput(signals: ProductSignals, candidates: { nodeId: string; score: number }[], index: ClassifierIndex): ResolverInput {
  const nameById = new Map(index.leaves.map((l) => [l.nodeId, l.displayName]));
  return {
    signals,
    candidates: candidates.map((c) => ({ nodeId: c.nodeId, displayName: nameById.get(c.nodeId) ?? c.nodeId, score: c.score })),
    departments: index.departments,
  };
}

/** Deterministic classify, then resolver fallback for low-confidence cases. */
export async function classifyWithFallback(
  signals: ProductSignals,
  index: ClassifierIndex,
  resolver: ClassifierResolver,
  opts: FallbackOptions = {}
): Promise<FallbackResult> {
  const det = classify(signals, index, opts);
  const autoT = opts.autoThreshold ?? 0.7;

  // Only high-trust ALIAS hits auto-assign. Lexical matches are candidates that
  // the resolver (LLM in prod; propose/abstain in dry-run) must confirm — a
  // lexical token-overlap alone must never force-fit.
  if (det.nodeId && det.method === "alias" && det.confidence >= autoT) {
    return { outcome: "assign", nodeId: det.nodeId, confidence: det.confidence, source: "alias", alternatives: det.alternatives };
  }

  const decision = await resolver.resolve(buildResolverInput(signals, det.alternatives, index));
  switch (decision.kind) {
    case "assign":
      return { outcome: "assign", nodeId: decision.nodeId, confidence: decision.confidence, source: "resolver", alternatives: det.alternatives, ...(decision.reason ? { reason: decision.reason } : {}) };
    case "propose_node":
      return { outcome: "propose_node", nodeId: null, confidence: 0, source: "resolver", alternatives: det.alternatives, proposedNode: { parentId: decision.parentId, suggestedName: decision.suggestedName }, ...(decision.reason ? { reason: decision.reason } : {}) };
    case "abstain":
      return { outcome: "abstain", nodeId: null, confidence: det.confidence, source: "resolver", alternatives: det.alternatives, ...(decision.reason ? { reason: decision.reason } : {}) };
  }
}
