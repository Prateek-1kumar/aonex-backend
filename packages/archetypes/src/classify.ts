export interface ClassifySignals {
  categoryPath?: string;
  title?: string;
  brand?: string;
}

const RULES: { id: string; category: RegExp; title: RegExp }[] = [
  {
    id: "smartphone",
    category: /mobile[_ ]?phone|smartphone|\bphones?\b/i,
    title: /\b(phone|pixel|iphone|galaxy|smartphone|5g)\b/i,
  },
];

/** Deterministic, explainable classification. Returns the archetype id or
 *  "unknown". (LLM/embedding fallback lands in Phase 3.)
 *
 *  Spec/plan review-hardening note: abstain to "unknown" on both no-match AND
 *  ambiguous-match (≥2 archetypes' rules fire); never pick one. With only
 *  smartphone registered, ambiguous is impossible today — but implement the
 *  semantics so adding a second archetype later doesn't bite. */
export function classifyArchetype(s: ClassifySignals): string {
  const matches: string[] = [];
  for (const r of RULES) {
    const hit =
      (s.categoryPath != null && r.category.test(s.categoryPath)) ||
      (s.title != null && r.title.test(s.title));
    if (hit) matches.push(r.id);
  }
  // No match → unknown. Multiple matches → abstain to unknown (plan review-hardening).
  if (matches.length !== 1) return "unknown";
  return matches[0]!;
}
