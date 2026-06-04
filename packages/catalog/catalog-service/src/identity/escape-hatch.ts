// Identity gate "escape hatch" — identitySatisfied (spec C3 / D2).
//
// Returns true when a strong identifier (gtin/mpn) is present, OR the product
// legitimately has none (identifierExists=false) — so genuinely id-less products
// aren't blocked from admission. Used by the catalog admission gate.

import { strongKeys, type Identifier } from "./identifier-set.js";

/** The identity requirement (gate) is satisfied if a strong id is present, OR
 *  the product legitimately has none (identifier_exists=false). Spec C3, D2. */
export function identitySatisfied(ids: Identifier[], identifierExists: boolean): boolean {
  if (!identifierExists) return true;
  return strongKeys(ids).length > 0;
}
