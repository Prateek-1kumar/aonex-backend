import type { Archetype } from "../types.js";

export const smartphone: Archetype = {
  id: "smartphone",
  label: "Smartphone",
  attributes: [
    { field: "title", tier: "required", weight: 0.8 },
    { field: "brand", tier: "required", weight: 0.8 },
    { field: "base_price", tier: "required", weight: 1 },
    { field: "currency", tier: "required", weight: 1 },
    { field: "identifier", tier: "required", weight: 1 },
    { field: "category_path", tier: "required", weight: 0.6 },
    { field: "images", tier: "recommended", weight: 0.4 },
    { field: "storage", tier: "recommended", weight: 0.4 },
    { field: "color", tier: "recommended", weight: 0.3 },
    { field: "ram", tier: "recommended", weight: 0.3 },
    { field: "description_long", tier: "optional", weight: 0.2 },
  ],
};
