// Image URL normalization for enrichment pass.
// - resolve relative + protocol-relative URLs
// - pick largest srcset variant
// - drop data: URIs and noise (tracking pixels, favicons, social logos)
// - dedupe by exact URL after normalization
// - apply per-CDN upscalers (Shopify _small → base; can grow)

const NOISE_RE = /(pixel|beacon|track|spacer|1x1|favicon|logo|brand-mark|social-share|payment-method|app-store|google-play)/i;
const SHOPIFY_DOWNSCALE_RE = /_(small|thumb|compact|medium|grande|\d+x|\d+x\d+)\.(jpg|jpeg|png|webp)$/i;

export interface RawImg {
  url: string;
  alt?: string | null;
  srcset?: string | null;
}

export interface NormalizedImg {
  url: string;
  alt: string | null;
}

export function normalizeImageUrls(imgs: RawImg[], baseUrl: string): NormalizedImg[] {
  const seen = new Set<string>();
  const out: NormalizedImg[] = [];
  for (const img of imgs) {
    let url = pickBest(img);
    if (!url) continue;
    if (url.startsWith("data:")) continue;
    try {
      url = resolve(url, baseUrl);
    } catch {
      continue;
    }
    url = upscale(url);
    if (NOISE_RE.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, alt: img.alt ?? null });
  }
  return out;
}

function pickBest(img: RawImg): string | null {
  if (img.srcset) {
    const last = img.srcset.split(",").pop()?.trim().split(/\s+/)[0];
    if (last) return last;
  }
  return img.url || null;
}

function resolve(url: string, base: string): string {
  if (url.startsWith("//")) {
    const proto = new URL(base).protocol;
    return `${proto}${url}`;
  }
  if (url.startsWith("http")) return url;
  return new URL(url, base).toString();
}

function upscale(url: string): string {
  return url.replace(SHOPIFY_DOWNSCALE_RE, ".$2");
}
