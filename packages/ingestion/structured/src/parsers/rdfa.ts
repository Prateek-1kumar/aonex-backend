import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.80;

/**
 * RDFa parser — extracts Schema.org Product facts from RDFa attributes
 * (`typeof`, `property`, `content`, `vocab`, `prefix`) embedded in HTML.
 *
 * Implementation note: uses regex-based HTML walking rather than a DOM
 * parser (node-html-parser / cheerio are not package dependencies). This
 * is consistent with the existing microdata parser in this package.
 */
export function parseRdfa(rawHtml: string): ParserOutput {
  const empty: ParserOutput = {
    kind: "rdfa",
    facts: [],
    baselineConfidence: BASELINE_CONFIDENCE,
  };

  // 1. Find an element with typeof matching Schema.org Product.
  //    Accepts: typeof="schema:Product", typeof="Product",
  //             typeof="http://schema.org/Product"
  const productBlockStart = findProductTypeofIndex(rawHtml);
  if (productBlockStart === -1) return empty;

  // 2. Extract a "good enough" slice of HTML that covers the product element
  //    content. We take the substring from the typeof element's start to a
  //    reasonable bound (end of document or an enclosing </div>/<article>).
  //    A depth-aware extraction is not needed here because we scan forward
  //    for property= attributes until the document ends or we hit a sibling
  //    typeof="Product" that would indicate a new product (not nested).
  const slice = rawHtml.slice(productBlockStart);

  // 3. Walk through all elements in the slice that have a property= attribute.
  const facts = extractPropertyFacts(slice);

  if (facts.length === 0) return empty;

  return { kind: "rdfa", facts, baselineConfidence: BASELINE_CONFIDENCE };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the index of the first element with a typeof attribute matching a
 * Schema.org Product type. Returns -1 if not found.
 */
function findProductTypeofIndex(html: string): number {
  // Match any opening tag that contains typeof="schema:Product", typeof="Product",
  // or typeof="http://schema.org/Product".
  const RE = /<[a-z][^>]*\btypeof=["'](?:schema:Product|Product|http:\/\/schema\.org\/Product)["'][^>]*>/i;
  const m = RE.exec(html);
  return m ? m.index : -1;
}

/**
 * Map of RDFa property values → our rawKey names.
 * Handles both schema:-prefixed and bare forms.
 */
const PROPERTY_MAP: Record<string, string> = {
  "schema:name": "title",
  "name": "title",
  "schema:brand": "brand",
  "brand": "brand",
  "schema:gtin13": "gtin",
  "gtin13": "gtin",
  "schema:gtin14": "gtin",
  "gtin14": "gtin",
  "schema:gtin12": "gtin",
  "gtin12": "gtin",
  "schema:gtin8": "gtin",
  "gtin8": "gtin",
  "schema:gtin": "gtin",
  "gtin": "gtin",
  "schema:price": "base_price",
  "price": "base_price",
  "schema:description": "description",
  "description": "description",
};

/**
 * Extract facts from property= attributes within the slice. For each element
 * that has a property= attribute we recognise, we read:
 *   1. content= attribute value (preferred — avoids HTML noise)
 *   2. element text content (fallback)
 */
function extractPropertyFacts(slice: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  // Match any HTML tag that has property="..." — capture the full opening tag
  // and optionally the text content before the closing tag.
  const TAG_RE =
    /<([a-z][a-z0-9]*)[^>]*\bproperty=["']([^"']+)["'][^>]*>(.*?)<\/\1>|<([a-z][a-z0-9]*)[^>]*\bproperty=["']([^"']+)["'][^>]*\/?>(?!.*?<\/)/gi;

  // We use two separate patterns:
  // Pattern A: paired tags <tag property="...">text</tag>
  const PAIRED_RE =
    /<([a-z][a-z0-9]*)[^>]*\bproperty=["']([^"']+)["'][^>]*>(.*?)<\/\1>/gi;
  // Pattern B: void/self-closing tags like <meta property="..." content="..." />
  const VOID_RE =
    /<(?:meta|link|data)[^>]*\bproperty=["']([^"']+)["'][^>]*>/gi;

  // Process void elements first (meta, link, data) — always use content=.
  for (const m of slice.matchAll(VOID_RE)) {
    const propAttr = m[1]!.trim();
    const rawKey = resolveRawKey(propAttr);
    if (!rawKey || seen.has(rawKey)) continue;

    const fullTag = m[0]!;
    const contentVal = extractAttrValue(fullTag, "content");
    if (!contentVal) continue;

    pushFact(facts, rawKey, contentVal, seen);
  }

  // Process paired elements — prefer content= over inner text.
  for (const m of slice.matchAll(PAIRED_RE)) {
    const propAttr = m[2]!.trim();
    const rawKey = resolveRawKey(propAttr);
    if (!rawKey || seen.has(rawKey)) continue;

    const fullOpenTag = m[0]!.slice(0, m[0]!.indexOf(">") + 1);
    const contentVal = extractAttrValue(fullOpenTag, "content");
    const textVal = contentVal ?? stripTags(m[3] ?? "").trim();

    if (!textVal) continue;
    pushFact(facts, rawKey, textVal, seen);
  }

  void TAG_RE; // declared for documentation; not used directly
  return facts;
}

function resolveRawKey(propAttr: string): string | null {
  return PROPERTY_MAP[propAttr] ?? null;
}

/** Extract the value of a named attribute from a tag string. */
function extractAttrValue(tag: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}=["']([^"']*)["']`, "i");
  const m = re.exec(tag);
  return m ? m[1]!.trim() || null : null;
}

/** Strip HTML tags from a string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function makeFact(rawKey: string, extractedValue: unknown): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue,
    normalizedValue: extractedValue,
    unit: null,
    sourcePointer: `rdfa:property=${rawKey}`,
    extractionMethod: "direct",
    confidence: BASELINE_CONFIDENCE,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  };
}

function pushFact(
  facts: ExtractedFact[],
  rawKey: string,
  rawValue: string,
  seen: Set<string>
): void {
  if (seen.has(rawKey)) return;
  seen.add(rawKey);

  // Coerce numeric fields.
  if (rawKey === "base_price") {
    const n = Number(rawValue);
    if (Number.isFinite(n)) {
      facts.push(makeFact(rawKey, n));
    }
    return;
  }

  if (rawValue.trim()) {
    facts.push(makeFact(rawKey, rawValue.trim()));
  }
}
