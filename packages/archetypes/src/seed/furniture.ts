// Furniture archetype — sofas, chairs, tables, beds, outdoor seating, …

import type { Archetype } from "../types.js";

export const furniture: Archetype = {
  id: "furniture",
  label: "Furniture",
  attributes: [
    { field: "title", tier: "required", weight: 0.8 },
    { field: "brand", tier: "required", weight: 0.6 },
    { field: "base_price", tier: "required", weight: 1 },
    { field: "currency", tier: "required", weight: 1 },
    { field: "identifier", tier: "required", weight: 0.6 },
    { field: "category_path", tier: "required", weight: 0.7 },
    { field: "images", tier: "recommended", weight: 0.5 },
    { field: "product_type", tier: "recommended", weight: 0.5 },
    { field: "material", tier: "recommended", weight: 0.4 },
    { field: "dimensions", tier: "recommended", weight: 0.4 },
    { field: "description_long", tier: "recommended", weight: 0.3 },
    { field: "seating_capacity", tier: "optional", weight: 0.3 },
    { field: "weight_capacity", tier: "optional", weight: 0.2 },
    { field: "frame_material", tier: "optional", weight: 0.2 },
    { field: "assembly_required", tier: "optional", weight: 0.2 },
    { field: "care_instructions", tier: "optional", weight: 0.2 },
  ],
};
