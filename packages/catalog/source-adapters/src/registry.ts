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
