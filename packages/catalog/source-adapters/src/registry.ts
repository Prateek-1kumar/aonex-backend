// Source-adapter registry for @aonex/catalog-source-adapters.
//
// In-memory Map keyed by SourceAdapter.sourceKind. registerAdapter() populates
// it (called from src/index.ts); getAdapter(sourceKind) resolves the adapter for
// an incoming source and throws if none is registered.

import type { SourceAdapter } from "./types.js";

const registry = new Map<string, SourceAdapter>();

export function registerAdapter(a: SourceAdapter): void {
  registry.set(a.sourceKind, a);
}

export function getAdapter(sourceKind: string): SourceAdapter {
  const a = registry.get(sourceKind);
  if (!a) throw new Error(`No adapter registered for source_kind=${sourceKind}`);
  return a;
}
