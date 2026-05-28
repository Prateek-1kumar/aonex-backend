/** Business-importance weights. Identity + price dominate (D4: weighted, never
 *  equal). A missing GTIN must hurt the score far more than a missing 5th image. */
const WEIGHTS: Record<string, number> = {
  gtin: 1,
  mpn: 1,
  identifier: 1,
  base_price: 1,
  currency: 1,
  title: 0.8,
  brand: 0.8,
  category_path: 0.6,
  images: 0.4,
  model_number: 0.4,
  description_short: 0.3,
  description_long: 0.2,
};

const DEFAULT_WEIGHT = 0.2;

export const CRITICAL_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(WEIGHTS).filter(([, w]) => w === 1).map(([k]) => k)
);

export function fieldWeight(field: string): number {
  return WEIGHTS[field] ?? DEFAULT_WEIGHT;
}
