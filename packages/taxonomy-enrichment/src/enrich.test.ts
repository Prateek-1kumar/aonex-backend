import { describe, expect, test } from "bun:test";
import { acceptedAttributes, enrichProduct } from "./enrich.js";
import type { ChatProvider, EnrichField, EnrichmentInput } from "./types.js";

const schema: EnrichField[] = [
  { key: "brand", tier: "required" },
  { key: "storage", tier: "required" },
  { key: "color", tier: "required", enumValues: ["Black", "White", "Blue"] },
  { key: "operating-system", tier: "required", enumValues: ["iOS", "Android"] },
  { key: "network", tier: "recommended", enumValues: ["4G", "5G"] },
];

/** A provider that returns a fixed body, ignoring the prompt. */
function stub(content: string): ChatProvider {
  return {
    async chatCompletion() {
      return { content, model: "stub-model", usage: { promptTokens: 10, completionTokens: 20 } };
    },
  };
}

const input: EnrichmentInput = {
  nodeId: "electronics/.../mobile-phones",
  schema,
  product: { title: "Apple iPhone 15 128GB Black", brand: "Apple" },
};

describe("enrichProduct", () => {
  test("lifts completeness, grounds reads, caps inferences, rejects bad enums", async () => {
    const body = JSON.stringify({
      fields: {
        brand: { value: "Apple", confidence: 0.95, evidence: "Apple" },
        storage: { value: "128GB", confidence: 0.9, evidence: "128GB" },
        color: { value: "Black", confidence: 0.9, evidence: "Black" },
        "operating-system": { value: "iOS", confidence: 0.9, inferred: true, evidence: "" },
        network: { value: "Fiber", confidence: 0.8, inferred: true }, // not an allowed enum, no close match
      },
      candidates: [{ key: "refresh_rate", label: "Refresh Rate", dataType: "string", value: "120Hz" }],
    });

    const r = await enrichProduct(input, { provider: stub(body), model: "x" });

    // Before/after lift (input had no attrs at all). Auto-applied = grounded only.
    expect(r.completenessBefore.score).toBe(0);
    expect(r.completenessAfter.score).toBeGreaterThan(r.completenessBefore.score);
    expect(r.completenessAfter.required).toBe(0.75); // 3 grounded of 4 required auto-applied
    expect(r.completenessProposed.required).toBe(1); // + inferred OS, pending confirmation

    const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
    expect(byKey.brand!.grounding).toBe("grounded");
    expect(byKey.brand!.accepted).toBe(true);

    // Inferred-but-confident: NOT auto-applied, but proposable, confidence capped.
    expect(byKey["operating-system"]!.grounding).toBe("inferred");
    expect(byKey["operating-system"]!.accepted).toBe(false);
    expect(byKey["operating-system"]!.proposable).toBe(true);
    expect(byKey["operating-system"]!.calibratedConfidence).toBeLessThanOrEqual(0.6);

    // Off-enum value: surfaced but neither applied nor proposed.
    expect(byKey.network!.status).toBe("invalid");
    expect(byKey.network!.accepted).toBe(false);
    expect(byKey.network!.proposable).toBe(false);

    expect(r.proposedInferred).toBe(1);
    expect(r.groundingRate).toBe(1); // every auto-applied field is source-grounded
    expect(r.candidates[0]!.key).toBe("refresh_rate");

    // Auto-applied set excludes the inferred OS until a human confirms it.
    expect(acceptedAttributes(r)).toMatchObject({ brand: "Apple", storage: "128GB", color: "Black" });
    expect(acceptedAttributes(r)["operating-system"]).toBeUndefined();
    expect(acceptedAttributes(r).network).toBeUndefined();
  });

  test("acceptInferred=true auto-applies confident inferences", async () => {
    const body = JSON.stringify({
      fields: { "operating-system": { value: "iOS", confidence: 0.9, inferred: true } },
    });
    const r = await enrichProduct(input, {
      provider: stub(body),
      model: "x",
      calibration: { wModel: 0.4, wGround: 0.6, acceptThreshold: 0.5, coercedPenalty: 0.92, inferredCeiling: 0.6, acceptInferred: true },
    });
    const os = r.fields.find((f) => f.key === "operating-system")!;
    expect(os.accepted).toBe(true);
    expect(acceptedAttributes(r)["operating-system"]).toBe("iOS");
  });

  test("rejects a value that contradicts a known source fact", async () => {
    const body = JSON.stringify({ fields: { color: { value: "White", confidence: 0.99 } } });
    const r = await enrichProduct(
      { ...input, product: { ...input.product, knownAttrs: { color: "black" } } },
      { provider: stub(body), model: "x" }
    );
    const color = r.fields.find((f) => f.key === "color")!;
    expect(color.grounding).toBe("contradicted");
    expect(color.accepted).toBe(false);
  });

  test("model/parse failure degrades to an empty result with before-score intact", async () => {
    const bad: ChatProvider = {
      async chatCompletion() {
        return { content: "I cannot help with that." };
      },
    };
    const r = await enrichProduct(input, { provider: bad, model: "x" });
    expect(r.error).toBeDefined();
    expect(r.fields.every((f) => !f.accepted)).toBe(true);
    expect(r.completenessAfter.score).toBe(r.completenessBefore.score);
  });
});
