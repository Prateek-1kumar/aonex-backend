// HLD §9 / engineering principles §11 — Strategy + Registry.
// extractorFor(marketplace) is the ONLY sanctioned way to look up
// a per-marketplace extractor. NEVER use if/switch chains on marketplace name.

import type { ArtifactExtractor } from "./types.js";
import { shopifyExtractor } from "./strategies/shopify.js";

const REGISTRY = new Map<string, ArtifactExtractor>([["shopify", shopifyExtractor]]);

/**
 * Returns the extractor for the given marketplace.
 * Throws for unregistered marketplaces — callers should catch and mark
 * the extraction_run as failed with reason 'unsupported_marketplace'.
 */
export function extractorFor(marketplace: string): ArtifactExtractor {
  const extractor = REGISTRY.get(marketplace);
  if (!extractor) {
    throw new Error(`No field extractor registered for marketplace: ${marketplace}`);
  }
  return extractor;
}

export function isMarketplaceSupported(marketplace: string): boolean {
  return REGISTRY.has(marketplace);
}
