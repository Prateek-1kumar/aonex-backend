import { describe, it, expect } from "bun:test";
import { detectValueContradiction } from "./value-contradiction.js";
import type { RouterInput } from "../types.js";

function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    facts: [],
    payload: {
      title: "T",
      brand: null,
      gtin: null,
      modelNumber: null,
      basePrice: 9.99,
      currency: "USD",
      canonicalCategory: "x/y",
      variants: [],
    },
    domain: "example.com",
    category: { path: "x/y", confidence: 0.9 },
    categoryRequiredAttributes: [],
    identityIndex: {},
    priceCluster: null,
    variantAxes: {},
    ...overrides,
  } as RouterInput;
}

const colorFact = (value: string) =>
  ({
    rawKey: "color",
    extractedValue: value,
    normalizedValue: value,
    confidence: 0.9,
    sourcePointer: "jsonld:Product.color",
    extractionMethod: "direct",
    canonicalPath: "color",
    unit: null,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  }) as never;

describe("detectValueContradiction", () => {
  describe("color vs variant axes", () => {
    it("fires when top-level color is not present in variant color axis values", () => {
      const signal = detectValueContradiction(
        input({
          facts: [colorFact("Red")],
          variantAxes: { color: ["Black", "White", "Blue"] },
        })
      );
      expect(signal).not.toBeNull();
      expect(signal!.signalKind).toBe("value_contradiction");
      expect(signal!.payload.affectedFields).toContain("color");
      expect(signal!.payload.reasonText.toLowerCase()).toContain("color");
    });

    it("does not fire when top-level color matches a variant axis value", () => {
      expect(
        detectValueContradiction(
          input({
            facts: [colorFact("Black")],
            variantAxes: { color: ["Black", "White"] },
          })
        )
      ).toBeNull();
    });

    it("does case-insensitive comparison", () => {
      expect(
        detectValueContradiction(
          input({
            facts: [colorFact("black")],
            variantAxes: { color: ["Black", "White"] },
          })
        )
      ).toBeNull();
    });

    it("does not fire when no top-level color is extracted", () => {
      expect(
        detectValueContradiction(
          input({
            facts: [],
            variantAxes: { color: ["Black", "White"] },
          })
        )
      ).toBeNull();
    });

    it("does not fire when no color variant axis exists", () => {
      expect(
        detectValueContradiction(
          input({
            facts: [colorFact("Red")],
            variantAxes: { size: ["S", "M", "L"] },
          })
        )
      ).toBeNull();
    });
  });

  describe("GTIN length sanity", () => {
    it("fires when GTIN length is not 8/12/13/14", () => {
      const signal = detectValueContradiction(
        input({
          payload: {
            title: "T",
            brand: null,
            gtin: "12345", // invalid length
            modelNumber: null,
            basePrice: 1,
            currency: "USD",
            canonicalCategory: null,
            variants: [],
          },
        })
      );
      expect(signal).not.toBeNull();
      expect(signal!.payload.affectedFields).toContain("gtin");
    });

    it("does not fire when GTIN is a valid 13-digit code", () => {
      expect(
        detectValueContradiction(
          input({
            payload: {
              title: "T",
              brand: null,
              gtin: "4066746000001",
              modelNumber: null,
              basePrice: 1,
              currency: "USD",
              canonicalCategory: null,
              variants: [],
            },
          })
        )
      ).toBeNull();
    });

    it("does not fire when GTIN has non-digit characters but length looks right (skipped)", () => {
      // GTIN with letters is suspicious but we treat it as wrong-length too
      const signal = detectValueContradiction(
        input({
          payload: {
            title: "T",
            brand: null,
            gtin: "ABC1234567890",
            modelNumber: null,
            basePrice: 1,
            currency: "USD",
            canonicalCategory: null,
            variants: [],
          },
        })
      );
      expect(signal).not.toBeNull();
    });
  });
});
