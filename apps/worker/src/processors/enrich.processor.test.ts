// toProposalFields — the pure projection from the enrichment engine's result
// onto the persisted proposal-field rows (Lab-UI- and apply-flow-compatible).

import { describe, expect, test } from "bun:test";
import type { EnrichmentResult, FieldResult } from "@aonex/taxonomy-enrichment";
import { toProposalFields } from "./enrich.processor.js";

const baseField: FieldResult = {
  key: "fit",
  tier: "required",
  raw: "Slim",
  normalized: "Slim",
  status: "ok",
  grounding: "grounded",
  support: 1,
  modelConfidence: 0.9,
  calibratedConfidence: 0.92,
  accepted: true,
  proposable: true,
  action: "fill",
};

function mkResult(fields: FieldResult[]): EnrichmentResult {
  const completeness = { score: 0, required: 0, recommended: 0, optional: 0 } as EnrichmentResult["completenessBefore"];
  return {
    nodeId: "fashion/jeans",
    fields,
    candidates: [],
    completenessBefore: completeness,
    completenessAfter: completeness,
    completenessProposed: completeness,
    contentQualityBefore: completeness,
    contentQualityProposed: completeness,
    groundingRate: 1,
    contentGroundingRate: 0,
    proposedInferred: 0,
  };
}

describe("toProposalFields", () => {
  test("maps engine fields to the persisted UI/apply-compatible shape", () => {
    const rows = toProposalFields(mkResult([baseField]), { fit: "slim fit" }, new Map([["fit", "descriptive"]]));
    expect(rows).toEqual([
      {
        attributeCode: "fit",
        group: "descriptive",
        before: "slim fit",
        after: "Slim",
        confidence: 0.92,
        action: "fill",
        valid: true,
        grounding: "grounded",
        support: 1,
        accepted: true,
        proposable: true,
      },
    ]);
  });

  test("drops missing fields and protected commerce facts", () => {
    const rows = toProposalFields(
      mkResult([
        { ...baseField, key: "material", raw: null, status: "missing", accepted: false, proposable: false },
        { ...baseField, key: "price", raw: 99 },
      ]),
      {},
      new Map()
    );
    expect(rows).toEqual([]);
  });

  test("invalid fields carry the validation error and valid:false", () => {
    const rows = toProposalFields(
      mkResult([
        {
          ...baseField,
          key: "network",
          raw: "6G",
          normalized: undefined,
          status: "invalid",
          grounding: "weak",
          support: 0.2,
          accepted: false,
          proposable: false,
          message: 'not an allowed value (closest: "5G")',
        },
      ]),
      {},
      new Map()
    );
    expect(rows[0]).toMatchObject({
      attributeCode: "network",
      after: "6G",
      valid: false,
      validationError: 'not an allowed value (closest: "5G")',
      accepted: false,
    });
  });
});
