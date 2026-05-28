// packages/archetypes/src/types.ts
export type AttributeTier = "required" | "recommended" | "optional";

export interface AttributeSpec {
  field: string;            // canonical field name
  tier: AttributeTier;
  weight: number;           // business importance within this archetype (D4: weighted)
}

export interface Archetype {
  id: string;               // matches catalog_products.family
  label: string;
  attributes: AttributeSpec[];
}

export interface CompletenessResult {
  score: number;            // weighted required-coverage in [0,1]
  meetsThreshold: boolean;
  missingRequired: string[];     // ordered by weight desc
  missingRecommended: string[];
  hardFloorOk: boolean;          // title + identity-or-escape-hatch present
}
