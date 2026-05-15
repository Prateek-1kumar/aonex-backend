const NAME_MAP: Record<string, string> = {
  color: "color",
  colour: "color",
  color_family: "color",
  colour_family: "color",
  colorway: "color",
  size: "size",
  size_uk: "size",
  size_us: "size",
  size_eu: "size",
  size_in: "size",
  size_inch: "size",
  ram: "ram",
  storage: "storage",
};

export function normalizeAxisName(raw: string): string {
  const key = raw
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return NAME_MAP[key] ?? key;
}

const PURE_LETTER_SIZE = /^[a-z]+$/i;

export function normalizeAxisValue(axis: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  switch (axis) {
    case "color":
      return trimmed
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    case "size":
      if (PURE_LETTER_SIZE.test(trimmed)) return trimmed.toUpperCase();
      return trimmed;
    default:
      return trimmed;
  }
}
