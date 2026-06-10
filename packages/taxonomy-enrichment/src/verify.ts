// Fact-tuple verifier — the "don't trust the LLM judge" layer.
//
// An LLM will happily emit a high self-confidence on a value it invented. So we
// independently, deterministically check every generated value against the
// product's OWN data and classify how it is supported:
//
//   grounded     — the value (or the span the model cited) is present in source.
//   weak         — only partial/fuzzy support.
//   inferred     — no source support; a plausible world-knowledge derivation
//                  (e.g. "iPhone 15" -> os: iOS). Kept, but down-weighted.
//   contradicted — conflicts with an explicit known source value -> rejected.
//
// This is a grounding check, not a truth oracle: "inferred" values are often
// correct, but they are not anchored in the merchant's data, so calibration
// trusts them less and the eval reports them separately.

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
  return {
    text,
    tokenSet: new Set(text ? text.split(" ") : []),
    numeralSet: new Set(numerals(parts.join(" "))),
    knownAttrs: known,
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

  // 5) No source support — a world-knowledge inference. Plausible, not anchored:
  //    support is low enough to stay well below "grounded", but high enough that a
  //    CONFIDENT inference (e.g. iPhone -> iOS) can clear the accept bar while a
  //    hesitant one cannot. Calibration caps these so they never present as certain.
  return { grounding: "inferred", support: 0.35, detail: "no source support (inferred)" };
}
