export type Dimension = "length" | "mass" | "volume" | "energy" | "power" | "frequency";

const CANONICAL: Record<Dimension, string> = {
  length: "cm",
  mass: "g",
  volume: "ml",
  energy: "Wh",
  power: "W",
  frequency: "Hz",
};

const FACTORS: Record<string, { dim: Dimension; toCanonical: number }> = {
  in: { dim: "length", toCanonical: 2.54 },
  cm: { dim: "length", toCanonical: 1 },
  mm: { dim: "length", toCanonical: 0.1 },
  m: { dim: "length", toCanonical: 100 },
  ft: { dim: "length", toCanonical: 30.48 },

  g: { dim: "mass", toCanonical: 1 },
  kg: { dim: "mass", toCanonical: 1000 },
  oz: { dim: "mass", toCanonical: 28.3495 },
  lb: { dim: "mass", toCanonical: 453.592 },

  ml: { dim: "volume", toCanonical: 1 },
  l: { dim: "volume", toCanonical: 1000 },
  L: { dim: "volume", toCanonical: 1000 },

  Wh: { dim: "energy", toCanonical: 1 },
  mAh: { dim: "energy", toCanonical: NaN }, // requires voltage; treat as non-convertible

  W: { dim: "power", toCanonical: 1 },
  kW: { dim: "power", toCanonical: 1000 },

  Hz: { dim: "frequency", toCanonical: 1 },
  kHz: { dim: "frequency", toCanonical: 1000 },
};

export function canonicalUnitFor(dim: Dimension): string {
  return CANONICAL[dim];
}

export function convertToCanonical(
  value: number,
  unit: string,
  dim: Dimension
): { value: number; unit: string } | null {
  const f = FACTORS[unit];
  if (!f || f.dim !== dim) return null;
  if (!Number.isFinite(f.toCanonical)) return null;
  return { value: value * f.toCanonical, unit: CANONICAL[dim] };
}
