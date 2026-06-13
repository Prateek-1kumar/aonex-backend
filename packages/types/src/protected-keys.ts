// Commerce facts (price, inventory, identity identifiers) that LLM enrichment
// must NEVER write; these come from sources/reconciliation only. The canonical
// set lives in this zero-dep package so every enrichment write-path enforces it.

export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "base_price", "price", "pricing", "currency",
  "inventory", "stock", "qty",
  "identifier", "gtin", "mpn", "sku", "upc", "asin",
]);
