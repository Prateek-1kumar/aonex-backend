// Phase 2: typed multi-identifier set + strength tiers + invariant-enforcing upsert.
// Spec C1/D2, plan review-hardening (Phase 2 §15).
//
// The set lives in catalog_products.identifiers (jsonb). Every writer goes through
// upsertIdentifier so the invariant "≤1 strong value per type per variant" is
// enforced — a second, different strong value of the same type returns "conflict"
// for the caller to freeze + review, never silent overwrite.

export type IdentifierType =
  | "gtin" | "upc" | "mpn" | "asin" | "shopify_gid" | "ebay_id" | "merchant_sku";

export type Strength = "strong" | "namespace" | "tenant" | "weak";

export interface Identifier {
  type: IdentifierType;
  value: string;
  source: string;          // e.g. "connector:shopify", "link:croma", "backfill:icecat"
  corroborated?: boolean;  // D3: a backfilled key is strong only once corroborated
}

const NAMESPACE_TYPES = new Set<IdentifierType>(["asin", "shopify_gid", "ebay_id"]);
const UNIVERSAL_TYPES = new Set<IdentifierType>(["gtin", "upc", "mpn"]);

/** Strength tier of a single identifier. D3: backfill+!corroborated is weak;
 *  promoteBackfill is the ONLY code path that may set corroborated=true. */
export function identifierStrength(id: Identifier): Strength {
  if (id.source.startsWith("backfill") && !id.corroborated) return "weak";
  if (UNIVERSAL_TYPES.has(id.type)) return "strong";
  if (NAMESPACE_TYPES.has(id.type)) return "namespace";
  if (id.type === "merchant_sku") return "tenant";
  return "weak";
}

export function strongKeys(ids: Identifier[]): Identifier[] {
  return ids.filter((i) => identifierStrength(i) === "strong");
}

/** True iff a and b share at least one STRONG key value — the only auto-merge basis (D2). */
export function matchOnStrong(a: Identifier[], b: Identifier[]): boolean {
  const bStrong = new Set(strongKeys(b).map((i) => `${i.type}:${i.value}`));
  return strongKeys(a).some((i) => bStrong.has(`${i.type}:${i.value}`));
}

// ---- Upsert with invariant enforcement (review-hardening) -------------------

export type UpsertResult =
  | { kind: "added";     set: Identifier[] }
  | { kind: "unchanged"; set: Identifier[] }
  | { kind: "promoted";  set: Identifier[] }
  | { kind: "conflict";  set: Identifier[]; existing: Identifier; incoming: Identifier };

const STRENGTH_RANK: Record<Strength, number> = {
  strong: 4, namespace: 3, tenant: 2, weak: 1,
};

/** Idempotent identifier upsert that enforces the spec invariant:
 *  ≤1 STRONG value per type per variant. A second, different strong value of the
 *  same type → "conflict" (the set is NOT mutated; caller must freeze + review). */
export function upsertIdentifier(set: Identifier[], incoming: Identifier): UpsertResult {
  const incomingStrength = identifierStrength(incoming);

  // Invariant first: a second STRONG value of the same type with a DIFFERENT
  // value blocks all writes for the caller to handle (freeze + review_task).
  if (incomingStrength === "strong") {
    const conflicting = set.find(
      (i) => i.type === incoming.type && i.value !== incoming.value && identifierStrength(i) === "strong"
    );
    if (conflicting) {
      return { kind: "conflict", set, existing: conflicting, incoming };
    }
  }

  // Same (type, value) — idempotent or promote-strength
  const sameIdx = set.findIndex((i) => i.type === incoming.type && i.value === incoming.value);
  if (sameIdx >= 0) {
    const existing = set[sameIdx]!;
    const existingStrength = identifierStrength(existing);
    if (STRENGTH_RANK[incomingStrength] > STRENGTH_RANK[existingStrength]) {
      const next = set.slice();
      next[sameIdx] = incoming;
      return { kind: "promoted", set: next };
    }
    return { kind: "unchanged", set };
  }

  // New (type, value)
  return { kind: "added", set: [...set, incoming] };
}
