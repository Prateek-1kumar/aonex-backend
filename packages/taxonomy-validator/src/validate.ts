// Taxonomy validator — validate + normalize a product's attributes against a
// leaf schema. Pure function; consumed by the admission gate, the Lab, the
// enrichment verifier, and the eval's schema-violation metric.

import { coerceEnum, parseUnit } from "./normalize.js";
import type {
  AttributeSpec,
  Completeness,
  FieldOutcome,
  LeafSchema,
  Tier,
  ValidationResult,
} from "./types.js";

const TIER_SHARE: Record<Tier, number> = { required: 0.7, recommended: 0.25, optional: 0.05 };

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function validateOne(spec: AttributeSpec, raw: unknown): FieldOutcome {
  const base = { key: spec.key, tier: spec.tier } as const;
  if (isEmpty(raw)) return { ...base, status: "missing" };

  const dataType = spec.dataType ?? "string";

  // Enum-constrained (single or array of enums).
  if (spec.enumValues && spec.enumValues.length > 0) {
    const items = Array.isArray(raw) ? raw : [raw];
    const coerced = items.map((it) => coerceEnum(it, spec.enumValues!));
    const bad = coerced.find((c) => c.status === "invalid");
    if (bad) return { ...base, status: "invalid", value: raw, ...(bad.suggestion ? { suggestion: bad.suggestion } : {}), message: "value not in allowed set" };
    const values = coerced.map((c) => c.value!);
    const anyCoerced = coerced.some((c) => c.status === "coerced");
    const normalized = Array.isArray(raw) ? values : values[0];
    return { ...base, status: anyCoerced ? "coerced" : "ok", value: raw, normalized };
  }

  // Numeric (with optional unit + range).
  if (dataType === "number" || spec.unit) {
    const p = parseUnit(raw, spec.unit, spec.allowedUnits ?? []);
    if (p.status === "invalid") return { ...base, status: "invalid", value: raw, ...(p.suggestion ? { suggestion: p.suggestion } : {}), message: "not a valid number/unit" };
    const n = p.value!;
    if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max))
      return { ...base, status: "invalid", value: raw, message: `out of range [${spec.min ?? "-∞"}, ${spec.max ?? "∞"}]` };
    const normalized = p.unit ? { value: n, unit: p.unit } : n;
    return { ...base, status: p.status === "ok" ? "ok" : "coerced", value: raw, normalized };
  }

  if (dataType === "boolean") {
    if (typeof raw === "boolean") return { ...base, status: "ok", value: raw, normalized: raw };
    const s = String(raw).toLowerCase();
    if (["true", "yes", "1"].includes(s)) return { ...base, status: "coerced", value: raw, normalized: true };
    if (["false", "no", "0"].includes(s)) return { ...base, status: "coerced", value: raw, normalized: false };
    return { ...base, status: "invalid", value: raw, message: "not a boolean" };
  }

  // Free string / array.
  return { ...base, status: "ok", value: raw, normalized: raw };
}

/** Validate + normalize `attrs` against a leaf schema. */
export function validateAttributes(schema: LeafSchema, attrs: Record<string, unknown>): ValidationResult {
  const fields = schema.attributes.map((spec) => validateOne(spec, attrs[spec.key]));

  const satisfied = (o: FieldOutcome) => o.status === "ok" || o.status === "coerced";
  const cov = (tier: Tier): number => {
    const specs = schema.attributes.filter((s) => s.tier === tier);
    if (specs.length === 0) return 0;
    const got = fields.filter((f) => f.tier === tier && satisfied(f)).length;
    return got / specs.length;
  };
  const required = cov("required");
  const recommended = cov("recommended");
  const optional = cov("optional");

  let weighted = 0;
  let totalShare = 0;
  for (const tier of ["required", "recommended", "optional"] as Tier[]) {
    if (schema.attributes.some((s) => s.tier === tier)) {
      totalShare += TIER_SHARE[tier];
      weighted += TIER_SHARE[tier] * { required, recommended, optional }[tier];
    }
  }
  const completeness: Completeness = {
    required,
    recommended,
    optional,
    score: totalShare === 0 ? 100 : Math.round((weighted / totalShare) * 10000) / 100,
  };

  return {
    nodeId: schema.nodeId,
    fields,
    completeness,
    missingRequired: fields.filter((f) => f.tier === "required" && f.status === "missing").map((f) => f.key),
    violations: fields.filter((f) => f.status === "invalid").length,
  };
}
