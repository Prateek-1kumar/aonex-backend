/**
 * Spec §6.6 — decide when to escalate to vision-LLM tier-3.
 *
 * Vision is expensive ($0.001-0.005/call) and slow (1-3s). Only fire
 * when text-extraction failed AND there are signals that the missing
 * fields likely live in an image:
 *   - apparel size charts: img alt/src patterns containing "size-chart", "sizing"
 *   - electronics spec graphics: large hero img near .product-spec or img with
 *     class "spec-image"
 *   - image-rendered prices: presence of img patterns matching "price",
 *     "sale", "deal" AND missing a text price already
 */

export type VisionEscalationSignal =
  | "size_chart_image"
  | "spec_graphic_image"
  | "image_rendered_price"
  | "no_text_price_with_image_carousel";

export interface VisionEscalationDecision {
  escalate: boolean;
  reasons: VisionEscalationSignal[];
}

const SIZE_CHART_PATTERN = /size[-_]?chart|sizing[-_]?(?:guide|chart)|size[-_]?guide/i;
const SPEC_GRAPHIC_PATTERN = /spec[-_]?image|specification[-_]?graphic|tech[-_]?specs[-_]?img/i;
const PRICE_IMAGE_PATTERN = /(?:price|sale|deal|discount)[-_]?(?:img|image|graphic|banner)/i;

/**
 * Inspect raw HTML for image-based signals that vision would help with.
 *
 * `hasTextPrice` is supplied by the caller — if a structured/DOM parser
 * already pulled a text price, the image-price signal is suppressed.
 */
export function shouldEscalateToVision(opts: {
  rawHtml: string;
  hasTextPrice: boolean;
  /** Number of facts the upstream layers (A/B/G/LLM) already extracted. */
  upstreamFactCount: number;
}): VisionEscalationDecision {
  const reasons: VisionEscalationSignal[] = [];

  if (SIZE_CHART_PATTERN.test(opts.rawHtml)) reasons.push("size_chart_image");
  if (SPEC_GRAPHIC_PATTERN.test(opts.rawHtml)) reasons.push("spec_graphic_image");
  if (!opts.hasTextPrice && PRICE_IMAGE_PATTERN.test(opts.rawHtml)) {
    reasons.push("image_rendered_price");
  }

  // Image carousel + no text price + low fact count → could be an image-only
  // listing (some marketplace sellers do this).
  const carouselPresent = /class\s*=\s*["'][^"']*(?:image-carousel|product-gallery|image-gallery|carousel)/i.test(opts.rawHtml);
  if (carouselPresent && !opts.hasTextPrice && opts.upstreamFactCount < 3) {
    reasons.push("no_text_price_with_image_carousel");
  }

  return {
    // Don't blanket-vision: require at least one specific signal AND that
    // upstream layers underperformed (few facts) OR price is missing entirely.
    escalate: reasons.length > 0 && (opts.upstreamFactCount < 5 || !opts.hasTextPrice),
    reasons
  };
}
