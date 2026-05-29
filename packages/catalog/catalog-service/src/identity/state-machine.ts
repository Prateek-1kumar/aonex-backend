// Phase 2 Task 10: explicit product state machine (spec target §12A).
//
// NOTE on naming: these are the CONCEPTUAL states defined by the spec. The DB
// column catalog_products.status currently uses some legacy values ("draft",
// "merged_into") that downstream wiring (Task 13) will map to these conceptual
// states. Don't compare DB values directly to PRODUCT_STATES; route through
// the mapping layer that Task 13 will introduce.

export const PRODUCT_STATES = ["staged", "active", "frozen_pending_review", "archived", "merged"] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

const LEGAL: Record<ProductState, ProductState[]> = {
  staged: ["active", "archived", "merged"],
  active: ["frozen_pending_review", "archived", "merged"],
  frozen_pending_review: ["active", "archived"],
  archived: ["active"],
  merged: [], // terminal
};

export function canTransition(from: ProductState, to: ProductState): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}
