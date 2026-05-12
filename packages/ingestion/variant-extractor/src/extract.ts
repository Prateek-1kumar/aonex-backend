// HLD §8 — Variant Extractor pure function.
// Detects parent+variant combinations; no flattening.
// variant_key is a deterministic hash of sorted normalized axis values
// so the same color/size maps to the same key across syncs.

import { sha256Hex, canonicalStringify } from "@aonex/lib-utils";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";
import type { CategorySchema } from "@aonex/db";
import type { VariantExtractionResult, VariantSpec } from "./types.js";

/**
 * Pure function — reads variant-level facts from the mapped fact set and the
 * category schema's variant_options to assemble VariantSpec rows.
 *
 * @param mappedFactSet - output of the Semantic Mapper
 * @param categorySchema - null when category was undetected; yields zero variants
 */
export function extractVariants(
  mappedFactSet: MappedFactSet,
  categorySchema: CategorySchema | null
): VariantExtractionResult {
  const facts = mappedFactSet.facts;

  // Collect variant indices from facts like "variants[0].sku"
  const variantIndices = new Set<number>();
  for (const f of facts) {
    const m = f.rawKey.match(/^variants\[(\d+)\]/);
    if (m) variantIndices.add(parseInt(m[1]!, 10));
  }

  if (variantIndices.size === 0) {
    return { parentFields: buildParentFields(facts), variants: [] };
  }

  // Determine canonical variant axes from categorySchema.variant_options
  // e.g. { Color: ["Red","Blue"], Size: ["S","M","L"] }
  const axisNames = categorySchema ? Object.keys(categorySchema.variantOptions) : [];

  const variants: VariantSpec[] = [];

  for (const idx of Array.from(variantIndices).sort((a, b) => a - b)) {
    const prefix = `variants[${idx}]`;

    const skuFact = facts.find((f) => f.rawKey === `${prefix}.sku`);
    const barcodeFact = facts.find((f) => f.rawKey === `${prefix}.barcode`);
    const priceFact = facts.find((f) => f.rawKey === `${prefix}.price`);

    // Build variantAxes from selectedOption facts
    const variantAxes: Record<string, string> = {};
    for (const axisName of axisNames) {
      const optionFact = facts.find((f) => f.rawKey === `${prefix}.option.${axisName}`);
      if (optionFact?.extractedValue != null) {
        variantAxes[axisName] = String(optionFact.extractedValue);
      }
    }
    // If no axis names from schema, fall back to any option facts we find
    if (axisNames.length === 0) {
      for (const f of facts) {
        const optMatch = f.rawKey.match(new RegExp(`^variants\\[${idx}\\]\\.option\\.(.+)$`));
        if (optMatch) {
          variantAxes[optMatch[1]!] = String(f.extractedValue ?? "");
        }
      }
    }

    const variantKey = buildVariantKey(variantAxes);
    const price = priceFact?.normalizedValue != null ? Number(priceFact.normalizedValue) : null;

    variants.push({
      variantKey,
      sku: skuFact?.extractedValue != null ? String(skuFact.extractedValue) : null,
      barcode: barcodeFact?.extractedValue != null ? String(barcodeFact.extractedValue) : null,
      price: isNaN(price!) ? null : price,
      currency: null, // resolved from merchant's default currency (Phase 4)
      inventoryQuantity: null,
      variantAxes
    });
  }

  return { parentFields: buildParentFields(facts), variants };
}

/** Deterministic hash of sorted normalized variant axis key-value pairs. */
function buildVariantKey(axes: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(axes)
      .map(([k, v]) => [k.toLowerCase().trim(), v.toLowerCase().trim()])
      .sort(([a], [b]) => a!.localeCompare(b!))
  );
  return sha256Hex(canonicalStringify(sorted)).slice(0, 16);
}

function buildParentFields(facts: MappedFactSet["facts"]): Record<string, unknown> {
  const parent: Record<string, unknown> = {};
  for (const f of facts) {
    if (!f.rawKey.startsWith("variants[") && f.canonicalPath) {
      parent[f.canonicalPath] = f.normalizedValue ?? f.extractedValue;
    }
  }
  return parent;
}
