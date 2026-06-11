import { describe, expect, test } from "bun:test";
import { enrichProduct } from "./enrich.js";
import { validateContentField } from "./content-validate.js";
import { verifyContentField, buildVerifyContext } from "./verify.js";
import type { ChatProvider, EnrichField, EnrichmentInput } from "./types.js";

const specSchema: EnrichField[] = [
  { key: "color", tier: "required", kind: "spec", enumValues: ["Black", "Blue", "White"] },
  { key: "fabric", tier: "required", kind: "spec" },
];
const contentSchema: EnrichField[] = [
  { key: "meta_title", tier: "required", kind: "content", contentType: "text", weight: 0.6, constraints: { maxLen: 60 } },
  { key: "seo_keywords", tier: "required", kind: "content", contentType: "string_list", weight: 0.7, constraints: { minItems: 3, maxItems: 8, maxLen: 40 } },
  { key: "description_long", tier: "required", kind: "content", contentType: "text", weight: 0.9, constraints: { maxLen: 1200 } },
];

/** Two-stage provider: spec body on the extraction call, content body on the copy call. */
function twoStage(specBody: string, contentBody: string): ChatProvider {
  return {
    async chatCompletion(req) {
      const sys = (req.messages?.[0]?.content as string) ?? "";
      const isContent = /copywriter|SEO\/AEO|CONFIRMED FACTS/i.test(sys);
      return { content: isContent ? contentBody : specBody, model: "stub", usage: { promptTokens: 5, completionTokens: 10 } };
    },
  };
}

const input: EnrichmentInput = {
  nodeId: "fashion/clothing/jeans",
  nodePath: "Fashion › Clothing › Jeans",
  schema: [...specSchema, ...contentSchema],
  product: { title: "Levis 511 Slim Fit Blue Jeans", brand: "Levis" },
};

describe("two-stage content enrichment", () => {
  test("synthesizes content, grounds it, never auto-applies it", async () => {
    const specBody = JSON.stringify({
      fields: {
        color: { value: "Blue", confidence: 0.9, evidence: "Blue" },
        fabric: { value: "Denim", confidence: 0.8, inferred: true },
      },
    });
    const contentBody = JSON.stringify({
      fields: {
        meta_title: { value: "Levis 511 Slim Fit Blue Jeans", confidence: 0.9, evidence: "title" },
        seo_keywords: { value: ["slim fit jeans", "blue denim", "levis jeans", "mens jeans"], confidence: 0.85 },
        description_long: { value: "These Levis 511 jeans bring a slim fit in a classic blue denim. Comfortable and versatile for everyday wear.", confidence: 0.8 },
      },
    });

    const r = await enrichProduct(input, { provider: twoStage(specBody, contentBody), model: "stub" });

    const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));

    // Specs behave as before: grounded color auto-applies, inferred fabric does not.
    expect(byKey.color!.accepted).toBe(true);

    // Content is generated, grounded (anchored in brand/type/color), but NEVER auto-applied.
    expect(byKey.meta_title!.kind).toBe("content");
    expect(byKey.meta_title!.grounding).toBe("grounded");
    expect(byKey.meta_title!.accepted).toBe(false);
    expect(byKey.meta_title!.proposable).toBe(true);
    expect(byKey.seo_keywords!.proposable).toBe(true);
    expect(byKey.description_long!.accepted).toBe(false);

    // Content quality lifts from 0 (fresh product) into the upside.
    expect(r.contentQualityBefore.score).toBe(0);
    expect(r.contentQualityProposed.score).toBeGreaterThan(0);
    expect(r.contentGroundingRate).toBeGreaterThan(0);
  });

  test("flags content that invents a figure not in the source", async () => {
    const ctx = buildVerifyContext({ title: "Levis Slim Jeans", brand: "Levis", knownAttrs: { color: "Blue" } });
    const ok = verifyContentField("Slim Levis jeans in blue", ctx);
    expect(ok.grounding).toBe("grounded");

    const fabricated = verifyContentField("Slim Levis jeans with a 42 inch waist", ctx);
    expect(fabricated.grounding).toBe("weak");
    expect(fabricated.detail).toContain("42");

    const generic = verifyContentField("Shop the best products at great prices today", ctx);
    expect(generic.grounding).toBe("inferred");
  });

  test("content validator normalizes shape + length", () => {
    const titleField: EnrichField = { key: "meta_title", tier: "required", kind: "content", contentType: "text", constraints: { maxLen: 20 } };
    const long = validateContentField(titleField, "This title is definitely far too long to fit");
    expect(long.status).toBe("coerced");
    expect((long.normalized as string).length).toBeLessThanOrEqual(20);

    const listField: EnrichField = { key: "tags", tier: "recommended", kind: "content", contentType: "string_list", constraints: { minItems: 3, maxItems: 2 } };
    const list = validateContentField(listField, ["a", "a", "b", "c"]);
    expect(list.status).toBe("coerced"); // deduped + truncated to maxItems
    expect((list.normalized as string[]).length).toBe(2);

    const empty = validateContentField(titleField, "");
    expect(empty.status).toBe("missing");
  });
});
