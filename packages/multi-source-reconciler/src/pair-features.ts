// Phase 4 Task 2: multi-feature pair scorer for entity resolution.
// Title-embedding cosine + spec agreement + 5% price proximity → composite.
// Spec conflict on any shared spec hard-caps composite at 0.45 (variant guard echo).

export interface PairSide {
  titleEmbedding: number[];
  specs: Record<string, string>;
  price?: number;
}

export interface PairScore {
  composite: number;
  titleSim: number;
  specAgreement: number;
  priceProximity: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! ** 2;
    nb  += b[i]! ** 2;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function specAgree(a: Record<string, string>, b: Record<string, string>): number {
  const shared = Object.keys(a).filter((k) => k in b);
  if (shared.length === 0) return 0.5; // neutral when no shared specs
  const agree = shared.filter((k) => a[k]!.toLowerCase() === b[k]!.toLowerCase()).length;
  return agree / shared.length;
}

function priceProx(a?: number, b?: number): number {
  if (a == null || b == null || a === 0) return 0.5;
  return Math.abs(a - b) / a <= 0.05 ? 1 : 0;
}

/** Composite pair score. Spec conflict is a hard penalty — any disagreeing
 *  shared spec caps the composite well below the merge band (variant guard echo). */
export function scorePair(a: PairSide, b: PairSide): PairScore {
  const titleSim = cosine(a.titleEmbedding, b.titleEmbedding);
  const specAgreement = specAgree(a.specs, b.specs);
  const priceProximity = priceProx(a.price, b.price);
  let composite = 0.5 * titleSim + 0.3 * specAgreement + 0.2 * priceProximity;
  if (specAgreement < 1 && Object.keys(a.specs).some((k) => k in b.specs)) {
    composite = Math.min(composite, 0.45);
  }
  return { composite, titleSim, specAgreement, priceProximity };
}
