// Variant ↔ image linking by priority:
//   1. JSON-LD direct map (sku → image URLs)
//   2. DOM proximity map (variant key → image URL)
//   3. Color/option name match in alt text or URL path
// LLM fallback (Task 3.7 will wire it from the orchestrator).

export interface VariantInput {
  sku: string | null;
  option_values: Record<string, string>;
}

export interface LinkedVariant extends VariantInput {
  image_urls: string[];
}

const COLOR_OPT_KEYS = ["color", "colour"];

export function linkVariantsToImages(
  variants: VariantInput[],
  images: { url: string; alt: string | null }[],
  jsonLdMap?: Record<string, string[]>,
  domProximityMap?: Record<string, string>
): LinkedVariant[] {
  return variants.map((v) => {
    // 1. JSON-LD direct
    if (v.sku && jsonLdMap?.[v.sku]) {
      return { ...v, image_urls: jsonLdMap[v.sku]! };
    }

    // 2. DOM proximity
    const key = JSON.stringify(v.option_values);
    if (domProximityMap?.[key]) {
      return { ...v, image_urls: [domProximityMap[key]!] };
    }

    // 3. Color/option name match
    const colorKey = Object.keys(v.option_values).find((k) =>
      COLOR_OPT_KEYS.includes(k.toLowerCase())
    );
    if (colorKey) {
      const colorVal = v.option_values[colorKey]!.toLowerCase();
      const slug = colorVal.replace(/\s+/g, "-");
      const matches = images.filter((i) =>
        (i.alt?.toLowerCase().includes(colorVal)) ||
        i.url.toLowerCase().includes(slug)
      );
      if (matches.length === 1) {
        return { ...v, image_urls: [matches[0]!.url] };
      }
    }

    return { ...v, image_urls: [] };
  });
}
