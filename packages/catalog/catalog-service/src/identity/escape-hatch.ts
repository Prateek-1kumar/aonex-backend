import { strongKeys, type Identifier } from "./identifier-set.js";

/** The identity requirement (gate) is satisfied if a strong id is present, OR
 *  the product legitimately has none (identifier_exists=false). Spec C3, D2. */
export function identitySatisfied(ids: Identifier[], identifierExists: boolean): boolean {
  if (!identifierExists) return true;
  return strongKeys(ids).length > 0;
}
