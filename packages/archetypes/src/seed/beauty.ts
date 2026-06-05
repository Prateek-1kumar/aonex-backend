// Beauty / personal-care archetype — skincare, makeup, fragrance, haircare, …

import type { Archetype } from "../types.js";

export const beauty: Archetype = {
  id: "beauty",
  label: "Beauty & Personal Care",
  attributes: [
    { field: "title", tier: "required", weight: 0.8 },
    { field: "brand", tier: "required", weight: 0.7 },
    { field: "base_price", tier: "required", weight: 1 },
    { field: "currency", tier: "required", weight: 1 },
    { field: "identifier", tier: "required", weight: 0.6 },
    { field: "category_path", tier: "required", weight: 0.7 },
    { field: "images", tier: "recommended", weight: 0.5 },
    { field: "product_type", tier: "recommended", weight: 0.5 },
    { field: "volume", tier: "recommended", weight: 0.4 },
    { field: "skin_type", tier: "recommended", weight: 0.4 },
    { field: "key_ingredients", tier: "recommended", weight: 0.3 },
    { field: "description_long", tier: "recommended", weight: 0.3 },
    { field: "spf", tier: "optional", weight: 0.2 },
    { field: "finish", tier: "optional", weight: 0.2 },
    { field: "fragrance", tier: "optional", weight: 0.2 },
    { field: "usage_instructions", tier: "optional", weight: 0.2 },
  ],
};
