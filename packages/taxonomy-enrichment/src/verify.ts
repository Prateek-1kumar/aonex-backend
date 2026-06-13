// Fact-tuple verifier — the "don't trust the LLM judge" layer.
//
// An LLM will happily emit a high self-confidence on a value it invented. So we
// independently, deterministically check every generated value against the
// product's OWN data and classify how it is supported:
//
//   grounded     — the value (or the span the model cited) is present in source.
//   weak         — only partial/fuzzy support.
//   inferred     — no source support, but a world-knowledge derivation the model
//                  DECLARED (inferred flag + reasoning), e.g. "iPhone 15" -> iOS.
//                  Kept, but down-weighted.
//   unverified   — no source support AND no declared basis: a value emitted as if
//                  read, into an attribute the source never mentions. An unanchored
//                  fabrication — capped so low it neither applies nor surfaces.
//   contradicted — conflicts with an explicit known source value -> rejected.
//
// This is a grounding check, not a truth oracle: "inferred" values are often
// correct, but they are not anchored in the merchant's data, so calibration
// trusts them less and the eval reports them separately. The inferred/unverified
// split is what stops a clean hallucination into an empty attribute from
// masquerading as a confident, reviewable proposal.

import { normalizeText, numerals, tokens, valueToText } from "./text.js";
import type { FieldGeneration, GroundingVerdict, SourceProduct } from "./types.js";

const STOP = new Set([
  "the", "a", "an", "of", "for", "with", "and", "or", "in", "to", "by", "on",
  "size", "color", "colour", "type", "style", "made", "set",
]);

export interface VerifyContext {
  text: string;
  tokenSet: Set<string>;
  numeralSet: Set<string>;
  knownAttrs: Record<string, unknown>;
  /** Significant FACT tokens (brand/title/category + known attr values) — the
   *  anchors content must reference to count as "about this product". */
  anchorSet: Set<string>;
}

/** Build the grounding corpus from everything the product itself asserts. */
export function buildVerifyContext(product: SourceProduct): VerifyContext {
  const known = product.knownAttrs ?? {};
  const parts = [
    product.title,
    product.brand,
    product.sourceCategory,
    product.description,
    product.extraText,
    ...Object.values(known).map(valueToText),
  ];
  const text = normalizeText(parts.filter(Boolean).join(" "));
  // Anchors exclude free description prose (too noisy) — they are the hard facts:
  // brand, title, category breadcrumb, and confirmed attribute values.
  const anchorParts = [product.title, product.brand, product.sourceCategory, ...Object.values(known).map(valueToText)];
  return {
    text,
    tokenSet: new Set(text ? text.split(" ") : []),
    numeralSet: new Set(numerals(parts.join(" "))),
    knownAttrs: known,
    anchorSet: new Set(significantTokens(anchorParts.filter(Boolean).join(" "))),
  };
}

function significantTokens(value: unknown): string[] {
  const all = tokens(valueToText(value));
  const sig = all.filter((t) => t.length >= 2 && !STOP.has(t));
  return sig.length > 0 ? sig : all;
}

function coverage(items: string[], pool: Set<string>): number {
  if (items.length === 0) return 0;
  let hit = 0;
  for (const it of items) if (pool.has(it)) hit++;
  return hit / items.length;
}

/** Does a known value conflict with the generated one? Equal or one-contains-the
 *  other's tokens = consistent; otherwise a real conflict. */
function contradicts(known: unknown, gen: unknown): boolean {
  const k = normalizeText(valueToText(known));
  const g = normalizeText(valueToText(gen));
  if (!k || !g) return false;
  if (k === g || k.includes(g) || g.includes(k)) return false;
  const kt = new Set(tokens(k));
  const gt = tokens(g);
  // Any shared token => treat as the same fact expressed differently, not a conflict.
  return !gt.some((t) => kt.has(t));
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Classify how well one generated field is grounded in the product's own data. */
export function verifyField(gen: FieldGeneration, ctx: VerifyContext): GroundingVerdict {
  if (isEmpty(gen.value)) return { grounding: "inferred", support: 0, detail: "empty value" };

  // 1) Contradiction against an explicit known value wins — this is a hallucinated override.
  const known = ctx.knownAttrs[gen.key];
  if (!isEmpty(known) && contradicts(known, gen.value)) {
    return { grounding: "contradicted", support: 0, detail: `conflicts with known "${valueToText(known)}"` };
  }
  // A value that simply echoes a known source value is grounded by definition.
  if (!isEmpty(known) && !contradicts(known, gen.value)) {
    return { grounding: "grounded", support: 1, detail: "matches known source value" };
  }

  const vText = normalizeText(valueToText(gen.value));
  if (!vText) return { grounding: "inferred", support: 0.15 };

  // 2) Full phrase present in source -> strongly grounded.
  if (vText.length >= 2 && ctx.text.includes(vText)) {
    return { grounding: "grounded", support: 1, detail: "value present in source" };
  }

  // 3) Token / numeral coverage.
  const sig = significantTokens(gen.value);
  const tokCov = coverage(sig, ctx.tokenSet);
  const nums = numerals(valueToText(gen.value));
  const numCov = nums.length > 0 ? coverage(nums, ctx.numeralSet) : 0;
  const isNumeric = nums.length > 0 && sig.every((t) => /^\d+(\.\d+)?$/.test(t) || nums.includes(t));

  if (tokCov >= 0.999 || (isNumeric && numCov >= 0.999)) {
    return { grounding: "grounded", support: 0.9, detail: "all value tokens in source" };
  }

  // 4) Cited evidence span actually present in source + overlaps the value.
  const ev = normalizeText(gen.evidence ?? "");
  const evidenceBacks =
    ev.length >= 3 && ctx.text.includes(ev) && sig.some((t) => ev.includes(t));

  if (tokCov >= 0.5 || numCov >= 0.5 || evidenceBacks) {
    return { grounding: "weak", support: 0.5, detail: "partial source support" };
  }

  // 5) No source support. The split turns on what the model CLAIMED:
  //    - inferred:true  → the model declared "I derived this from world knowledge,
  //      I did not read it" (e.g. "iPhone 15" -> os: iOS). Honest about being
  //      unanchored → "inferred", support 0.35, so a confident one can clear review.
  //    - inferred:false → the model emitted the value AS IF read from the source,
  //      but it isn't there. A misread or a clean fabrication into an empty
  //      attribute → "unverified", support 0.15, capped below the review bar.
  if (gen.inferred === true) {
    return { grounding: "inferred", support: 0.35, detail: "world-knowledge inference (declared)" };
  }
  return { grounding: "unverified", support: 0.15, detail: "value not in source, not declared as inferred (unverified)" };
}

/** Grounding for SYNTHESIZED content (description/SEO/marketing/AEO).
 *
 *  Spec grounding asks "is this exact value in the source?". Content is composed,
 *  not extracted, so a substring test would reject all of it. Instead we enforce
 *  two things that together mean "written from the facts, not invented":
 *    (1) NO foreign hard facts — every NUMBER in the copy must appear in the
 *        source (a figure that doesn't is a fabricated spec — the cardinal sin).
 *    (2) ANCHORING — the copy must reference the product's actual facts
 *        (brand/type/attributes), not read as generic boilerplate.
 *  Adjectives and category framing are allowed; invented measurements are not. */
export function verifyContentField(value: unknown, ctx: VerifyContext): GroundingVerdict {
  if (isEmpty(value)) return { grounding: "inferred", support: 0, detail: "empty value" };
  const flat = valueToText(value);
  const text = normalizeText(flat);
  if (!text) return { grounding: "inferred", support: 0, detail: "empty value" };

  // (1) Fabricated-figure guard.
  const foreign = [...new Set(numerals(flat).filter((n) => !ctx.numeralSet.has(n)))];
  if (foreign.length > 0) {
    return { grounding: "weak", support: 0.4, detail: `figures not in source: ${foreign.join(", ")}` };
  }

  // (2) Anchoring against the product's fact tokens.
  const contentTokens = new Set(significantTokens(value));
  let hits = 0;
  for (const a of ctx.anchorSet) if (contentTokens.has(a)) hits++;
  const anchorScore = ctx.anchorSet.size === 0 ? 0 : hits / Math.min(ctx.anchorSet.size, 6);

  if (anchorScore >= 0.5) return { grounding: "grounded", support: 0.9, detail: "anchored in product facts" };
  if (anchorScore > 0) return { grounding: "weak", support: 0.6, detail: "loosely anchored in product facts" };
  return { grounding: "inferred", support: 0.3, detail: "generic copy — references no product fact" };
}
