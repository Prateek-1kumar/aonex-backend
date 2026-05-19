// Numeric + unit parser. Splits values like "1.5kg" → { value: 1.5, unit: "kg" }.
// Canonicalizes synonyms (grams → g, inches → in, etc.) to a small canonical set.

const UNIT_MAP: Record<string, string> = {
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  "fl oz": "floz", floz: "floz",
  ml: "ml", milliliter: "ml", milliliters: "ml",
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
  cm: "cm", centimeter: "cm", centimeters: "cm",
  mm: "mm", millimeter: "mm", millimeters: "mm",
  m: "m", meter: "m", meters: "m",
  in: "in", inch: "in", inches: "in",
  mah: "mAh",
  gb: "GB", tb: "TB", mb: "MB"
};

export function parseUnit(s: string): { value: number; unit: string } | null {
  if (!s) return null;
  // Match: optional minus sign, digits with optional decimal, optional whitespace, then "fl oz" OR word chars
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(fl\s*oz|[a-zA-Z]+)/i);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  if (!Number.isFinite(value)) return null;
  const raw = m[2]!.replace(/\s+/g, " ").toLowerCase();
  const unit = UNIT_MAP[raw];
  return unit ? { value, unit } : null;
}
