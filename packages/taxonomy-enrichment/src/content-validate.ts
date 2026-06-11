// Content shape + length/count validation (the Stage-2 analogue of the
// taxonomy-validator, which only understands typed specs).
//
// Synthesized content is heterogeneous (text / string list / Q&A list /
// pros-cons) and constrained by length and item counts, not enums/units. We
// NORMALIZE rather than reject: trim, drop empties, dedupe, truncate to limits —
// and flag (status "coerced") when we had to. Empty -> "missing". A value of the
// wrong shape that can't be salvaged -> "invalid". The fact-level guard ("did it
// invent a spec?") is the grounding verifier's job, not this one's.

import type { ContentConstraints, ContentType, EnrichField, FieldStatus } from "./types.js";

export interface ContentOutcome {
  key: string;
  status: FieldStatus;
  /** Normalized value to persist (when ok/coerced). */
  normalized?: unknown;
  message?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Truncate to maxLen at a word boundary where possible. */
function cap(s: string, maxLen?: number): { value: string; truncated: boolean } {
  if (!maxLen || s.length <= maxLen) return { value: s, truncated: false };
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return { value: (sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).trim(), truncated: true };
}

function normText(raw: unknown, c: ContentConstraints): { value?: string; coerced: boolean } {
  if (!isStr(raw)) {
    if (raw == null) return { coerced: false };
    raw = String(raw);
  }
  const s = clean(raw as string);
  if (!s) return { coerced: false };
  const { value, truncated } = cap(s, c.maxLen);
  return { value, coerced: truncated };
}

function normList(raw: unknown, c: ContentConstraints): { value?: string[]; coerced: boolean } {
  const arr = Array.isArray(raw) ? raw : isStr(raw) && raw.trim() ? [raw] : [];
  let coerced = !Array.isArray(raw) && arr.length > 0;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    if (!isStr(it)) {
      if (it == null) continue;
      coerced = true;
    }
    const s = clean(String(it));
    if (!s) continue;
    const { value, truncated } = cap(s, c.maxLen);
    if (truncated) coerced = true;
    const key = value.toLowerCase();
    if (seen.has(key)) {
      coerced = true;
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  if (c.maxItems && out.length > c.maxItems) {
    out.length = c.maxItems;
    coerced = true;
  }
  return out.length ? { value: out, coerced } : { coerced };
}

function normQaList(raw: unknown, c: ContentConstraints): { value?: { q: string; a: string }[]; coerced: boolean } {
  if (!Array.isArray(raw)) return { coerced: false };
  let coerced = false;
  const out: { q: string; a: string }[] = [];
  for (const it of raw) {
    const o = it as { q?: unknown; a?: unknown; question?: unknown; answer?: unknown };
    const q = clean(String(o?.q ?? o?.question ?? ""));
    const aFull = clean(String(o?.a ?? o?.answer ?? ""));
    if (!q || !aFull) {
      coerced = true;
      continue;
    }
    const { value: a, truncated } = cap(aFull, c.maxLen);
    if (truncated) coerced = true;
    out.push({ q, a });
  }
  if (c.maxItems && out.length > c.maxItems) {
    out.length = c.maxItems;
    coerced = true;
  }
  return out.length ? { value: out, coerced } : { coerced };
}

function normProsCons(raw: unknown, c: ContentConstraints): { value?: { pros: string[]; cons: string[] }; coerced: boolean } {
  const o = raw as { pros?: unknown; cons?: unknown };
  if (!o || typeof o !== "object") return { coerced: false };
  const pros = normList(o.pros, c);
  const cons = normList(o.cons, c);
  const value = { pros: pros.value ?? [], cons: cons.value ?? [] };
  if (!value.pros.length && !value.cons.length) return { coerced: false };
  return { value, coerced: pros.coerced || cons.coerced };
}

/** Validate + normalize one synthesized content value against its shape + limits. */
export function validateContentField(field: EnrichField, raw: unknown): ContentOutcome {
  const ct: ContentType = field.contentType ?? "text";
  const c = field.constraints ?? {};
  const base = { key: field.key };

  let res: { value?: unknown; coerced: boolean };
  switch (ct) {
    case "text":
      res = normText(raw, c);
      break;
    case "string_list":
      res = normList(raw, c);
      break;
    case "qa_list":
      res = normQaList(raw, c);
      break;
    case "pros_cons":
      res = normProsCons(raw, c);
      break;
  }

  if (res.value === undefined) {
    // A non-empty raw that produced nothing usable is malformed; truly empty is missing.
    const wasEmpty = raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    return wasEmpty ? { ...base, status: "missing" } : { ...base, status: "invalid", message: `malformed ${ct} value` };
  }

  // Under-filled lists are valid but lower quality (the content score down-weights them).
  const count = Array.isArray(res.value) ? res.value.length : undefined;
  const under = c.minItems !== undefined && count !== undefined && count < c.minItems;
  const message = under ? `only ${count}/${c.minItems} items` : undefined;

  return {
    ...base,
    status: res.coerced || under ? "coerced" : "ok",
    normalized: res.value,
    ...(message ? { message } : {}),
  };
}

/** True when a normalized content value meets its minItems/non-empty bar (for scoring). */
export function meetsContentBar(field: EnrichField, normalized: unknown): boolean {
  if (normalized === undefined || normalized === null || normalized === "") return false;
  const min = field.constraints?.minItems;
  if (Array.isArray(normalized)) return normalized.length >= (min ?? 1);
  if (field.contentType === "pros_cons") {
    const o = normalized as { pros?: unknown[]; cons?: unknown[] };
    return (o.pros?.length ?? 0) + (o.cons?.length ?? 0) >= (min ?? 1);
  }
  return true; // non-empty text
}
