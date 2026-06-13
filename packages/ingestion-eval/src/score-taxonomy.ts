// Taxonomy eval scoring (P0 Task 9). Pure functions; the runner supplies
// predictions (from a classifier) + a node-ancestry lookup.

/** Score one classification: exact=1, correct ancestor/descendant=0.5, same
 *  department=0.25, else 0. `ancestorsOf` returns a node's ancestor chain. */
export function scoreClassification(
  predicted: string | null,
  gold: string,
  ancestorsOf: (id: string) => string[]
): { exact: boolean; credit: number } {
  if (!predicted) return { exact: false, credit: 0 };
  if (predicted === gold) return { exact: true, credit: 1 };
  const goldAnc = new Set(ancestorsOf(gold));
  const predAnc = new Set(ancestorsOf(predicted));
  if (goldAnc.has(predicted) || predAnc.has(gold)) return { exact: false, credit: 0.5 };
  if (predicted.split("/")[0] === gold.split("/")[0]) return { exact: false, credit: 0.25 };
  return { exact: false, credit: 0 };
}

export interface ClassRow { exact: boolean; credit: number; predicted: string | null }
export interface ClassAgg {
  n: number;
  /** Fraction exactly correct (top-1 accuracy). */
  top1: number;
  /** Mean partial-credit score (ancestor/department aware). */
  weighted: number;
  /** Fraction the classifier could not resolve at all. */
  abstained: number;
}

export function aggregateClassification(rows: ClassRow[]): ClassAgg {
  const n = rows.length || 1;
  return {
    n: rows.length,
    top1: rows.filter((r) => r.exact).length / n,
    weighted: rows.reduce((s, r) => s + r.credit, 0) / n,
    abstained: rows.filter((r) => r.predicted === null).length / n,
  };
}

export interface PrecisionRecall {
  /** Exactly-correct / predictions that were not an abstain. */
  precision: number;
  /** Exactly-correct / all gold items. */
  recall: number;
  predicted: number;
  correct: number;
  total: number;
}

/** Precision/recall for the Catalog Quality Report headline. Precision = "when it
 *  commits to a leaf, how often is it right?"; recall = "of all products, how often
 *  did it land the exact right leaf?". Abstains lower recall but not precision. */
export function precisionRecall(rows: ClassRow[]): PrecisionRecall {
  const total = rows.length;
  const predicted = rows.filter((r) => r.predicted !== null).length;
  const correct = rows.filter((r) => r.exact).length;
  return {
    precision: predicted === 0 ? 0 : correct / predicted,
    recall: total === 0 ? 0 : correct / total,
    predicted,
    correct,
    total,
  };
}
