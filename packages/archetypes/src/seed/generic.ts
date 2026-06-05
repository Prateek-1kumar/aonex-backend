// Generic fallback archetype — used when classification abstains ("unknown").
// Keeps enrichment working for any product: core + a few universal descriptive attrs.

import type { Archetype } from "../types.js";

export const generic: Archetype = {
  id: "generic",
  label: "Generic Product",
  attributes: [
    { field: "title", tier: "required", weight: 0.8 },
    { field: "brand", tier: "required", weight: 0.6 },
    { field: "base_price", tier: "required", weight: 1 },
    { field: "currency", tier: "required", weight: 1 },
    { field: "identifier", tier: "required", weight: 0.5 },
    { field: "category_path", tier: "required", weight: 0.6 },
    { field: "images", tier: "recommended", weight: 0.5 },
    { field: "product_type", tier: "recommended", weight: 0.5 },
    { field: "material", tier: "recommended", weight: 0.3 },
    { field: "description_long", tier: "recommended", weight: 0.3 },
    { field: "color", tier: "optional", weight: 0.2 },
    { field: "dimensions", tier: "optional", weight: 0.2 },
  ],
};
