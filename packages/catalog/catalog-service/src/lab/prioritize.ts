// Phase 4 Task 5: value-at-stake queue prioritization for the Anomaly Lab.
// Higher price + closer to publishable (fewer missing fields) ranks first;
// age (capped at 72h) breaks ties so old items don't starve.

export interface QueueItemMeta {
  id: string;
  price: number;
  missingCount: number;
  ageHours: number;
}

/** Pure sort: returns a new array (input untouched). Score is value-at-stake
 *  with an age tiebreaker. */
export function prioritize(items: QueueItemMeta[]): QueueItemMeta[] {
  const score = (i: QueueItemMeta) =>
    Math.log10(i.price + 10) * 2 - i.missingCount + Math.min(i.ageHours, 72) / 72;
  return [...items].sort((a, b) => score(b) - score(a));
}
