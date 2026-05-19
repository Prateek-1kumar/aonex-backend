// Category-specific attribute key hints. The LLM uses these to know
// which attributes to look for. NOT enforced by the parser — it's a
// soft hint that boosts recall on common category specs.

export type AttributeBucket =
  | "apparel"
  | "electronics"
  | "beauty"
  | "food"
  | "furniture"
  | "toys"
  | "generic";

export type AttributeSchema = { category: AttributeBucket; keys: string[] };

export const ATTRIBUTE_SCHEMAS: Record<AttributeBucket, string[]> = {
  apparel: [
    "material",
    "fit",
    "sleeve_length",
    "neckline",
    "care_instructions",
    "country_of_origin",
    "size_chart_url",
    "pattern",
    "season",
  ],
  electronics: [
    "battery_life",
    "battery_capacity",
    "connectivity",
    "power_input",
    "weight",
    "dimensions",
    "screen_size",
    "resolution",
    "ports",
    "warranty_period",
  ],
  beauty: [
    "volume",
    "ingredients",
    "skin_type",
    "scent",
    "spf",
    "cruelty_free",
    "vegan",
    "paraben_free",
    "shelf_life",
  ],
  food: [
    "weight",
    "servings",
    "ingredients",
    "allergens",
    "nutrition_facts",
    "dietary_tags",
    "shelf_life",
    "storage_instructions",
  ],
  furniture: [
    "material",
    "dimensions",
    "weight",
    "assembly_required",
    "color_family",
    "style",
    "weight_capacity",
    "care_instructions",
  ],
  toys: [
    "age_range",
    "material",
    "battery_required",
    "number_of_pieces",
    "safety_certifications",
    "educational_focus",
  ],
  generic: ["material", "weight", "dimensions", "color", "warranty_period"],
};

export function pickAttributeSchema(
  category: string | null,
  confidence: number
): AttributeSchema {
  if (!category || confidence < 0.6)
    return { category: "generic", keys: ATTRIBUTE_SCHEMAS.generic };
  const bucket = bucketFor(category);
  return { category: bucket, keys: ATTRIBUTE_SCHEMAS[bucket] };
}

function bucketFor(path: string): AttributeBucket {
  const p = path.toLowerCase();
  if (
    /apparel|clothing|shoe|hat|sock|jacket|shirt|pant/.test(p)
  )
    return "apparel";
  if (
    /electronic|computer|phone|tablet|laptop|tv|audio|headphone|camera/.test(
      p
    )
  )
    return "electronics";
  if (/beauty|skincare|makeup|cosmetic|fragrance/.test(p))
    return "beauty";
  if (/food|grocery|snack|beverage|drink/.test(p))
    return "food";
  if (/furniture|sofa|chair|desk|table|bed|home/.test(p))
    return "furniture";
  if (/toy|game|puzzle|kids/.test(p))
    return "toys";
  return "generic";
}
