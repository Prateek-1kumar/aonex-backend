// Normalization primitives: fuzzy enum coercion + unit parsing.

import { editDistance } from "@aonex/lib-utils";

export { editDistance };

const canon = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();

/** Digits of a string in order — "usb 3.0" -> "30". Fuzzy coercion must never
 *  change a number: "6G" and "5G" are DIFFERENT values, not typos of each other. */
const digitsOf = (s: string) => s.replace(/\D+/g, "");

/** Minimum edit-distance similarity (1 - dist/maxLen) for a fuzzy coercion.
 *  A plain edit-distance budget coerced "6G" -> "5G" (distance 1); a ratio
 *  threshold makes short strings effectively uncoercible by fuzz. */
const FUZZY_SIMILARITY_MIN = 0.75;

export interface EnumCoercion {
  status: "ok" | "coerced" | "invalid";
  value?: string;
  suggestion?: string;
}

/** Coerce a raw value to an allowed enum: exact -> case/format -> fuzzy. */
export function coerceEnum(raw: unknown, allowed: string[]): EnumCoercion {
  if (typeof raw !== "string") return { status: "invalid", ...nearest(String(raw), allowed) };
  const exact = allowed.find((a) => a === raw);
  if (exact) return { status: "ok", value: exact };
  const ci = allowed.find((a) => canon(a) === canon(raw));
  if (ci) return { status: "coerced", value: ci };
  // Fuzzy: nearest allowed value, accepted only when (a) the similarity ratio
  // clears the threshold AND (b) no digit changes — a 1-char edit that flips a
  // number ("6G" -> "5G", "USB 3" -> "USB 2") is a wrong value, not a typo.
  const c = canon(raw);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const a of allowed) {
    const dist = editDistance(c, canon(a));
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  if (best) {
    const bc = canon(best);
    const similarity = 1 - bestDist / Math.max(c.length, bc.length, 1);
    if (similarity >= FUZZY_SIMILARITY_MIN && digitsOf(c) === digitsOf(bc)) {
      return { status: "coerced", value: best };
    }
  }
  return { status: "invalid", ...(best ? { suggestion: best } : {}) };
}

function nearest(raw: string, allowed: string[]): { suggestion?: string } {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const a of allowed) {
    const dist = editDistance(canon(raw), canon(a));
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  return best ? { suggestion: best } : {};
}

/** Minimal unit conversion factors to a canonical base, by family. */
const FACTORS: Record<string, Record<string, number>> = {
  mass: { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592 },
  data: { mb: 0.001, gb: 1, tb: 1000 },
  length: { mm: 0.1, cm: 1, m: 100, in: 2.54, ft: 30.48 },
};
const familyOf = (unit: string): string | undefined =>
  Object.keys(FACTORS).find((f) => unit.toLowerCase() in FACTORS[f]!);

export interface UnitParse {
  status: "ok" | "coerced" | "invalid";
  value?: number;
  unit?: string;
  suggestion?: string;
}

/**
 * Parse "256 GB" / "1.2kg" -> {value, unit}, converting to `canonicalUnit`
 * when both units share a family. allowedUnits gates recognized inputs.
 */
export function parseUnit(raw: unknown, canonicalUnit?: string, allowedUnits: string[] = []): UnitParse {
  const s = String(raw).trim();
  const m = /^(-?[\d.,]+)\s*([a-zA-Z%]+)?$/.exec(s);
  if (!m) return { status: "invalid" };
  const num = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(num)) return { status: "invalid" };
  const unit = m[2];
  if (!unit) return { status: canonicalUnit ? "coerced" : "ok", value: num, ...(canonicalUnit ? { unit: canonicalUnit } : {}) };
  const recognized = [canonicalUnit, ...allowedUnits].filter(Boolean) as string[];
  if (recognized.length && !recognized.some((u) => u.toLowerCase() === unit.toLowerCase()))
    return { status: "invalid", ...(canonicalUnit ? { suggestion: canonicalUnit } : {}) };
  if (canonicalUnit && canonicalUnit.toLowerCase() !== unit.toLowerCase()) {
    const fam = familyOf(unit);
    if (fam && canonicalUnit.toLowerCase() in FACTORS[fam]!) {
      const factor = FACTORS[fam]![unit.toLowerCase()]! / FACTORS[fam]![canonicalUnit.toLowerCase()]!;
      return { status: "coerced", value: num * factor, unit: canonicalUnit };
    }
  }
  return { status: unit === canonicalUnit ? "ok" : "coerced", value: num, unit: canonicalUnit ?? unit };
}
