import type { NormalizedImg } from "./image-normalizer.js";

export type ImageRole = "hero" | "gallery" | "swatch" | "lifestyle" | "spec" | "video_thumb";

export interface RoledImg extends NormalizedImg {
  role: ImageRole;
  position: number;
}

const LIFESTYLE_RE = /lifestyle|in[-_ ]use|on[-_ ]model|environment/i;
const SPEC_RE = /spec|dimension|sizing|chart|diagram/i;
const VIDEO_RE = /video[_-]?thumb|videothumb|\.mp4\b/i;

export function classifyImageRoles(
  imgs: NormalizedImg[],
  ogImage: string | null
): RoledImg[] {
  const out: RoledImg[] = [];
  let heroAssigned = false;

  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]!;
    let role: ImageRole = "gallery";
    const altLow = (img.alt ?? "").toLowerCase();
    const urlLow = img.url.toLowerCase();

    if (VIDEO_RE.test(urlLow)) {
      role = "video_thumb";
    } else if (SPEC_RE.test(urlLow) || SPEC_RE.test(altLow)) {
      role = "spec";
    } else if (LIFESTYLE_RE.test(urlLow) || LIFESTYLE_RE.test(altLow)) {
      role = "lifestyle";
    } else if (!heroAssigned && ogImage && img.url === ogImage) {
      role = "hero";
      heroAssigned = true;
    }

    out.push({ ...img, role, position: i });
  }

  // If hero hasn't been assigned by og:image match, force first non-noise to hero.
  if (!heroAssigned && out.length > 0) {
    const first = out.find((i) => i.role === "gallery");
    if (first) first.role = "hero";
  }

  return out;
}
