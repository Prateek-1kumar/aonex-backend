// Apparel archetype — clothing/footwear (jeans, shirts, dresses, …).
// Required commerce attrs drive completeness; descriptive attrs are the dynamic,
// type-specific fields the enricher fills (see seed/attribute-catalog.ts APPAREL).

import type { Archetype } from "../types.js";

export const apparel: Archetype = {
  id: "apparel",
  label: "Apparel",
  attributes: [
    { field: "title", tier: "required", weight: 0.8 },
    { field: "brand", tier: "required", weight: 0.7 },
    { field: "base_price", tier: "required", weight: 1 },
    { field: "currency", tier: "required", weight: 1 },
    { field: "identifier", tier: "required", weight: 0.6 },
    { field: "category_path", tier: "required", weight: 0.7 },
    { field: "images", tier: "recommended", weight: 0.5 },
    { field: "product_type", tier: "recommended", weight: 0.5 },
    { field: "fabric", tier: "recommended", weight: 0.4 },
    { field: "fit", tier: "recommended", weight: 0.4 },
    { field: "color", tier: "recommended", weight: 0.3 },
    { field: "description_long", tier: "recommended", weight: 0.3 },
    { field: "occasion", tier: "optional", weight: 0.3 },
    { field: "rise", tier: "optional", weight: 0.2 },
    { field: "wash", tier: "optional", weight: 0.2 },
    { field: "pattern", tier: "optional", weight: 0.2 },
    { field: "care_instructions", tier: "optional", weight: 0.2 },
  ],
};
