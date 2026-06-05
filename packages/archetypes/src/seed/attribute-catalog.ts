// Catalog enrichment — the typed attribute catalogue (code source of truth).
//
// One entry per canonical attribute the enricher can produce, with its data type
// and (where useful) allowed enum values for validation. This drives:
//   1) the DB seed of attribute_definitions (packages/db seed reads these), and
//   2) resolveActiveSchema(), which joins archetype specs to these typed defs.
//
// PROTECTED commerce facts (price/currency/inventory/identifiers) are intentionally
// ABSENT here — enrichment must never propose them. PROTECTED_KEYS is the hard guard.

export type EnrichmentGroup =
  | "core" // existing fields the enricher may improve (title, description, images)
  | "descriptive" // archetype-specific factual attrs (fit, storage, material…)
  | "occasion"
  | "care"
  | "marketing"
  | "seo"
  | "aeo"
  | "category";

export type AttrDataType = "string" | "number" | "boolean" | "array" | "object";

export interface AttrDef {
  key: string; // canonical_key
  label: string;
  group: EnrichmentGroup;
  dataType: AttrDataType;
  /** true = applies to every archetype (marketing/seo/aeo/category/core). */
  universal?: boolean;
  enumValues?: string[];
  unitType?: string;
  description?: string;
}

/** Commerce facts enrichment must never write — defense in depth on top of omission. */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "base_price", "price", "pricing", "currency",
  "inventory", "stock", "qty",
  "identifier", "gtin", "mpn", "sku", "upc", "asin",
]);

// ── Universal groups (apply to all products) ────────────────────────────────
const UNIVERSAL: AttrDef[] = [
  // core (improve existing)
  { key: "title", label: "Title", group: "core", dataType: "string", universal: true },
  { key: "brand", label: "Brand", group: "core", dataType: "string", universal: true, description: "Enrichable as normalization only — flagged: feeds identity resolution" },
  { key: "description_long", label: "Description", group: "core", dataType: "string", universal: true },
  { key: "images", label: "Images", group: "core", dataType: "array", universal: true },

  // marketing
  { key: "key_features", label: "Key Features", group: "marketing", dataType: "array", universal: true },
  { key: "benefits", label: "Benefits", group: "marketing", dataType: "array", universal: true, description: "Array of {label, text} benefit statements" },
  { key: "bullet_points", label: "Bullet Points", group: "marketing", dataType: "array", universal: true },
  { key: "highlights", label: "Highlights", group: "marketing", dataType: "array", universal: true },

  // seo
  { key: "meta_title", label: "Meta Title", group: "seo", dataType: "string", universal: true, description: "<= 60 chars" },
  { key: "meta_description", label: "Meta Description", group: "seo", dataType: "string", universal: true, description: "<= 160 chars" },
  { key: "meta_keywords", label: "Meta Keywords", group: "seo", dataType: "array", universal: true },
  { key: "seo_keywords", label: "SEO Keywords", group: "seo", dataType: "array", universal: true },
  { key: "tags", label: "Tags", group: "seo", dataType: "array", universal: true },
  { key: "url_slug", label: "URL Slug", group: "seo", dataType: "string", universal: true },

  // aeo / geo (Answer/Generative Engine Optimization)
  { key: "faq", label: "FAQ", group: "aeo", dataType: "array", universal: true, description: "Array of {q, a}" },
  { key: "pros_cons", label: "Pros & Cons", group: "aeo", dataType: "object", universal: true, description: "{pros[], cons[]}" },
  { key: "use_cases", label: "Use Cases", group: "aeo", dataType: "array", universal: true },
  { key: "comparison", label: "Comparison", group: "aeo", dataType: "string", universal: true, description: "Category positioning; no fabricated competitor claims" },
  { key: "aeo_summary", label: "AEO Summary", group: "aeo", dataType: "string", universal: true },

  // categories (deep breadcrumb + per-marketplace)
  { key: "category_path", label: "Category Path", group: "category", dataType: "array", universal: true, description: "Ordered deep breadcrumb, e.g. Home/Clothing/Men Clothing/Jeans/Brand" },
  { key: "google_category", label: "Google Category", group: "category", dataType: "string", universal: true },
  { key: "amazon_category", label: "Amazon Category", group: "category", dataType: "string", universal: true },
  { key: "walmart_category", label: "Walmart Category", group: "category", dataType: "string", universal: true },
  { key: "ebay_category", label: "eBay Category", group: "category", dataType: "string", universal: true },
  { key: "etsy_category", label: "Etsy Category", group: "category", dataType: "string", universal: true },
];

// ── Archetype-scoped descriptive attributes ─────────────────────────────────
const APPAREL: AttrDef[] = [
  { key: "product_type", label: "Product Type", group: "descriptive", dataType: "string" },
  { key: "fit", label: "Fit", group: "descriptive", dataType: "string", enumValues: ["Slim", "Regular", "Relaxed", "Skinny", "Loose", "Tailored", "Oversized"] },
  { key: "fabric", label: "Fabric / Material", group: "descriptive", dataType: "string" },
  { key: "rise", label: "Rise", group: "descriptive", dataType: "string", enumValues: ["Low Rise", "Mid Rise", "High Rise"] },
  { key: "wash", label: "Wash", group: "descriptive", dataType: "string", enumValues: ["Light", "Medium", "Dark", "Raw", "Acid", "Distressed"] },
  { key: "stretch", label: "Stretch", group: "descriptive", dataType: "string", enumValues: ["Non-Stretch", "Slight Stretch", "Stretch", "Super Stretch"] },
  { key: "closure", label: "Closure", group: "descriptive", dataType: "string", enumValues: ["Zip Fly", "Button Fly", "Elastic", "Drawstring", "Button", "Hook & Eye"] },
  { key: "pattern", label: "Pattern", group: "descriptive", dataType: "string", enumValues: ["Solid", "Striped", "Checked", "Printed", "Floral", "Polka Dot", "Graphic"] },
  { key: "sleeve_length", label: "Sleeve Length", group: "descriptive", dataType: "string", enumValues: ["Sleeveless", "Short Sleeve", "Half Sleeve", "Three-Quarter", "Full Sleeve"] },
  { key: "neckline", label: "Neckline", group: "descriptive", dataType: "string" },
  { key: "occasion", label: "Occasion", group: "occasion", dataType: "array", enumValues: ["Casual", "Formal", "Party", "Festive", "Sports", "Daily Wear", "Outdoor", "Work"] },
  { key: "care_instructions", label: "Care Instructions", group: "care", dataType: "array" },
];

const FURNITURE: AttrDef[] = [
  { key: "product_type", label: "Product Type", group: "descriptive", dataType: "string" },
  { key: "material", label: "Material", group: "descriptive", dataType: "string" },
  { key: "seating_capacity", label: "Seating Capacity", group: "descriptive", dataType: "number" },
  { key: "dimensions", label: "Dimensions", group: "descriptive", dataType: "string", description: "L x W x H" },
  { key: "weight_capacity", label: "Weight Capacity", group: "descriptive", dataType: "number", unitType: "mass" },
  { key: "frame_material", label: "Frame Material", group: "descriptive", dataType: "string" },
  { key: "assembly_required", label: "Assembly Required", group: "descriptive", dataType: "boolean" },
  { key: "care_instructions", label: "Care Instructions", group: "care", dataType: "array" },
  { key: "usage_instructions", label: "Usage Instructions", group: "care", dataType: "array" },
  { key: "whats_in_the_box", label: "What's in the Box", group: "care", dataType: "array" },
];

const BEAUTY: AttrDef[] = [
  { key: "product_type", label: "Product Type", group: "descriptive", dataType: "string" },
  { key: "skin_type", label: "Skin Type", group: "descriptive", dataType: "array", enumValues: ["Normal", "Dry", "Oily", "Combination", "Sensitive", "All"] },
  { key: "spf", label: "SPF", group: "descriptive", dataType: "number" },
  { key: "volume", label: "Volume / Net Weight", group: "descriptive", dataType: "string", unitType: "volume" },
  { key: "finish", label: "Finish", group: "descriptive", dataType: "string", enumValues: ["Matte", "Dewy", "Satin", "Glossy", "Natural"] },
  { key: "key_ingredients", label: "Key Ingredients", group: "descriptive", dataType: "array" },
  { key: "fragrance", label: "Fragrance", group: "descriptive", dataType: "string" },
  { key: "usage_instructions", label: "How to Use", group: "care", dataType: "array" },
];

const SMARTPHONE: AttrDef[] = [
  { key: "product_type", label: "Product Type", group: "descriptive", dataType: "string" },
  { key: "storage", label: "Storage", group: "descriptive", dataType: "string", unitType: "data" },
  { key: "ram", label: "RAM", group: "descriptive", dataType: "string", unitType: "data" },
  { key: "color", label: "Color", group: "descriptive", dataType: "string" },
  { key: "display_size", label: "Display Size", group: "descriptive", dataType: "string", unitType: "length" },
  { key: "battery", label: "Battery", group: "descriptive", dataType: "string" },
  { key: "os", label: "Operating System", group: "descriptive", dataType: "string" },
  { key: "camera", label: "Camera", group: "descriptive", dataType: "string" },
];

const GENERIC: AttrDef[] = [
  { key: "product_type", label: "Product Type", group: "descriptive", dataType: "string" },
  { key: "material", label: "Material", group: "descriptive", dataType: "string" },
  { key: "color", label: "Color", group: "descriptive", dataType: "string" },
  { key: "dimensions", label: "Dimensions", group: "descriptive", dataType: "string" },
];

/** Descriptive attribute defs grouped by archetype id. */
export const ARCHETYPE_DESCRIPTIVE: Record<string, AttrDef[]> = {
  apparel: APPAREL,
  furniture: FURNITURE,
  beauty: BEAUTY,
  smartphone: SMARTPHONE,
  generic: GENERIC,
};

/** Every distinct AttrDef (universal + all archetype descriptive), deduped by key.
 *  A key may appear in multiple archetypes (e.g. product_type) — first wins. */
export function allAttrDefs(): AttrDef[] {
  const byKey = new Map<string, AttrDef>();
  for (const d of UNIVERSAL) if (!byKey.has(d.key)) byKey.set(d.key, d);
  for (const defs of Object.values(ARCHETYPE_DESCRIPTIVE)) {
    for (const d of defs) if (!byKey.has(d.key)) byKey.set(d.key, d);
  }
  return [...byKey.values()];
}

export const UNIVERSAL_ATTRS: readonly AttrDef[] = UNIVERSAL;

/** Lookup a typed def by key across universal + all archetype descriptive sets. */
export function lookupAttrDef(key: string): AttrDef | undefined {
  return allAttrDefs().find((d) => d.key === key);
}
