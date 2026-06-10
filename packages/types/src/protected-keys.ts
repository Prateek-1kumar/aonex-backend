// Commerce facts LLM enrichment must NEVER write — price, inventory and
// identity identifiers come from sources/reconciliation only. Enforced as
// defense in depth at every enrichment write-path (engine omission, worker
// auto-apply, API apply), so the canonical set lives here in the zero-dep
// types package rather than in any one enrichment implementation.

export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "base_price", "price", "pricing", "currency",
  "inventory", "stock", "qty",
  "identifier", "gtin", "mpn", "sku", "upc", "asin",
]);
