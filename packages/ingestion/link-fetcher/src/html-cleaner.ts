// Strips boilerplate/noise from raw HTML and harvests structured data pre-extraction.
//
// cleanHtml returns a CleanResult: machine-readable structuredBlocks (JSON-LD,
// __NEXT_DATA__/Apollo/initial state, meta/link tags, microdata, images,
// breadcrumbs), region-marked + entity-decoded cleanedText, and a captchaSignal.
// Entry point of @aonex/ingestion-link-fetcher's cleaning stage.

import { flattenJsonLdNodes } from "./json-ld-blocks.js";
import type { CleanResult, StructuredBlocks } from "./types.js";

const MAX_CLEANED_TEXT_LENGTH = 200_000;
const CAPTCHA_KEYWORDS = /captcha|robot check|are you human|access denied/i;
const CAPTCHA_SIZE_THRESHOLD = 10_000;

export function cleanHtml(rawHtml: string): CleanResult {
  const structuredBlocks = extractStructuredBlocks(rawHtml);
  const captchaSignal =
    rawHtml.length < CAPTCHA_SIZE_THRESHOLD && CAPTCHA_KEYWORDS.test(rawHtml);

  let text = rawHtml;

  // Remove script/style/svg/nav/footer
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src =
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1] ??
      null;
    const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1];
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1];
    if (!src && !srcset) return " ";
    const urls = [src, srcset?.split(",").pop()?.trim().split(" ")[0]]
      .filter(Boolean)
      .join(" | ");
    return ` [img: ${urls}${alt ? ` | alt=${alt}` : ""}] `;
  });
  text = text.replace(
    /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    " $2 ($1) "
  );

  // Inject region markers for product content areas
  const REGIONS: { marker: string; re: RegExp }[] = [
    { marker: "[PRODUCT_TITLE]", re: /<(h1|h2)[^>]*class=["'][^"']*(product[-_]?title|pdp[-_]?title)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi },
    { marker: "[PRICE_REGION]", re: /<[^>]+class=["'][^"']*(price|pricing|cost)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi },
    { marker: "[DESCRIPTION]", re: /<[^>]+(id|class)=["'][^"']*(product[-_]?description|pdp[-_]?description|description)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi },
    { marker: "[SPECS]", re: /<[^>]+(id|class)=["'][^"']*(specs|specifications|tech-specs)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi },
    { marker: "[REVIEWS]", re: /<[^>]+(id|class)=["'][^"']*(reviews?|ratings?)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi }
  ];
  for (const { marker, re } of REGIONS) {
    text = text.replace(re, (_full, ...args) => {
      // args is [...captures, offset, fullString]. The last capture group is the inner content.
      const inner = args[args.length - 3];
      return ` ${marker} ${typeof inner === "string" ? inner : ""} `;
    });
  }

  text = text.replace(
    /<\/?(div|p|br|h[1-6]|li|tr|td|th|section|article|main|aside|blockquote)[^>]*>/gi,
    "\n"
  );
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\t/g, " ");
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  text = truncateCenterPreserving(text, MAX_CLEANED_TEXT_LENGTH);

  return { structuredBlocks, cleanedText: text, captchaSignal };
}

function extractStructuredBlocks(html: string): StructuredBlocks {
  const jsonLd: Record<string, unknown>[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const parsed = JSON.parse(m[1]!.trim());
      jsonLd.push(...flattenJsonLdNodes(parsed));
    } catch {
      /* malformed block — skip */
    }
  }

  const nextData = parseInlineScriptById(html, "__NEXT_DATA__");
  const apolloState = parseWindowAssignment(html, "__APOLLO_STATE__");
  const initialState = parseWindowAssignment(html, "__INITIAL_STATE__");

  const images: { url: string; alt: string | null; srcset: string | null }[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]!;
    const src =
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-zoom-image=["']([^"']+)["']/i)?.[1] ??
      null;
    if (!src) continue;
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? null;
    const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1] ?? null;
    images.push({ url: src, alt, srcset });
  }

  for (const m of html.matchAll(/<source\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/gi)) {
    const url = m[1]!.split(",").pop()!.trim().split(" ")[0]!;
    if (url) images.push({ url, alt: null, srcset: m[1]! });
  }

  for (const m of html.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)) {
    const inner = m[1]!;
    for (const im of inner.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      const alt = im[0]!.match(/\balt=["']([^"']*)["']/i)?.[1] ?? null;
      images.push({ url: im[1]!, alt, srcset: null });
    }
  }

  const metaTags: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]!;
    const key =
      tag.match(/\bproperty=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    if (key && content !== undefined) metaTags[key] = content;
  }

  const linkTags: Record<string, string> = {};
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]!;
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (rel && href) linkTags[rel] = href;
  }

  const microdata: { prop: string; value: string }[] = [];
  for (const m of html.matchAll(/<[^>]*\bitemprop=["']([^"']+)["'][^>]*>([^<]*)/gi)) {
    const prop = m[1]!;
    const inline = m[0]!;
    const contentAttr = inline.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    const value = contentAttr ?? (m[2] ?? "").trim();
    if (value) microdata.push({ prop, value });
  }

  const breadcrumbs: string[] = [];
  const navMatch = html.match(/<(nav|ol|ul)[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
  if (navMatch) {
    const inner = navMatch[2]!;
    for (const m of inner.matchAll(/>([^<]{1,80})</g)) {
      const t = m[1]!.trim();
      if (t && t !== ">" && t !== "/" && t !== "›") breadcrumbs.push(t);
    }
  }

  return {
    jsonLd,
    nextData,
    apolloState,
    initialState,
    metaTags,
    linkTags,
    microdata,
    images,
    breadcrumbs
  };
}

function parseInlineScriptById(
  html: string,
  id: string
): Record<string, unknown> | null {
  const re = new RegExp(
    `<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!.trim());
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function parseWindowAssignment(
  html: string,
  name: string
): Record<string, unknown> | null {
  const re = new RegExp(
    `window\\.${name}\\s*=\\s*(\\{[\\s\\S]*?\\});?\\s*(?:<\\/script>|window\\.)`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function truncateCenterPreserving(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 30) / 2);
  return (
    text.substring(0, half) +
    "\n[...middle truncated]\n" +
    text.substring(text.length - half)
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
    "&lsquo;": "‘",
    "&rsquo;": "’",
    "&ldquo;": "“",
    "&rdquo;": "”",
    "&trade;": "™",
    "&reg;": "®",
    "&copy;": "©",
    "&times;": "×",
    "&divide;": "÷",
    "&euro;": "€",
    "&pound;": "£",
    "&yen;": "¥",
    "&cent;": "¢",
    "&hellip;": "…",
    "&bull;": "•",
  };
  let result = text;
  for (const [e, c] of Object.entries(entities)) result = result.replaceAll(e, c);
  result = result.replace(/&#(\d+);/g, (_, dec) =>
    String.fromCharCode(parseInt(dec, 10))
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return result;
}
