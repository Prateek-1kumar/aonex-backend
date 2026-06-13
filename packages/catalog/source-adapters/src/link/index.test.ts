import { describe, expect, test } from "bun:test";
import { linkAdapter, type LinkAdapterInput } from "./index.js";
import type { AdaptContext } from "../types.js";
import flipkartSamsungJson from "./__fixtures__/flipkart-samsung.json" with { type: "json" };
import amazonPegasusJson from "./__fixtures__/amazon-pegasus.json" with { type: "json" };

const flipkartSamsung = flipkartSamsungJson as unknown as LinkAdapterInput;
const amazonPegasus = amazonPegasusJson as unknown as LinkAdapterInput;

function makeCtx(overrides: Partial<AdaptContext> = {}): AdaptContext {
  return {
    tenantId: "t1" as any,
    channelId: "ch1" as any,
    channelDefaultCurrency: "INR",
    channelDefaultLocale: "en_IN",
    attributeDefinitions: [],
    attributeSynonyms: [],
    ...overrides,
  };
}

describe("linkAdapter", () => {
  test("emits parent + pricing observations for a flipkart parent-only product", () => {
    const out = linkAdapter.adapt(flipkartSamsung, makeCtx());

    // Title scoped to channel
    const title = out.observations.find(
      (o) => o.attributeCode === "title" && o.target === "parent",
    );
    expect(title).toBeDefined();
    expect(title!.channelCode).toBe("flipkart");
    expect(title!.value).toContain("Samsung");
    expect(title!.source).toBe("flipkart:link");
    // Uses observedAt from envelope, not Date.now()
    expect(title!.observedAt.toISOString()).toBe("2026-05-20T10:00:00.000Z");
    // Confidence picked up from _field_confidence
    expect(title!.confidence).toBe(0.95);

    // Brand at _unscoped channel
    const brand = out.observations.find((o) => o.attributeCode === "brand");
    expect(brand).toBeDefined();
    expect(brand!.target).toBe("parent");
    expect(brand!.channelCode).toBe("_unscoped");
    expect(brand!.localeCode).toBe("_unscoped");
    expect(brand!.value).toBe("Samsung");

    // Pricing side-table observation (not in observations[])
    expect(out.pricingObservations.length).toBe(1);
    const pricing = out.pricingObservations[0]!;
    expect(pricing.currency).toBe("INR");
    expect(pricing.channelCode).toBe("flipkart");
    expect(pricing.tiers).toEqual([
      { kind: "list", amount: 129999 },
      { kind: "sale", amount: 59999 },
    ]);
    // Pricing is NOT in the canonical observations array
    expect(out.observations.find((o) => o.attributeCode === "price")).toBeUndefined();

    // Identity hint
    expect(out.identityHint.gtin).toBe("8806095269757");
    expect(out.identityHint.mpn).toBe("SM-S928BZKDINS");
    expect(out.identityHint.brand).toBe("Samsung");
    expect(out.identityHint.titleForFuzzy).toContain("Samsung");
    expect(out.identityHint.targetIsVariant).toBe(false);

    // Attributes from sku.attributes map → per-attribute observations
    const ram = out.observations.find((o) => o.attributeCode === "ram");
    expect(ram).toBeDefined();
    expect(ram!.value).toBe("12 GB");
    expect(ram!.target).toBe("parent");

    // Raw payload echoed back
    expect(out.rawPayload).toBe(flipkartSamsung.sku);

    // No inventory observations for link source (no qty)
    expect(out.inventoryObservations.length).toBe(0);
  });

  test("resolves attribute keys against the vocabulary: known→canonical, junk→custom.<slug>", () => {
    const input: LinkAdapterInput = {
      ...flipkartSamsung,
      sku: {
        ...flipkartSamsung.sku,
        attributes: {
          ram: { value: "12 GB", unit: null, source: "structured" },
          "search-alias": { value: ["search-alias=aps"], unit: null, source: "structured" },
          cpu_model: { value: "Snapdragon 8 Elite", unit: null, source: "structured" },
        },
      },
    };
    const ctx = makeCtx({
      attributeDefinitions: [
        { canonicalKey: "ram", canonicalUnit: null, dataType: "string", reconciliationPath: "sync" },
      ],
      attributeSynonyms: [],
    });

    const out = linkAdapter.adapt(input, ctx);

    // Recognized key stays first-class.
    const ram = out.observations.find((o) => o.attributeCode === "ram");
    expect(ram).toBeDefined();
    expect(ram!.value).toBe("12 GB");

    // Unrecognized page junk is quarantined under custom.<slug> — never first-class.
    expect(out.observations.find((o) => o.attributeCode === "search-alias")).toBeUndefined();
    const junk = out.observations.find((o) => o.attributeCode === "custom.search_alias");
    expect(junk).toBeDefined();
    expect(junk!.extras?.raw_key).toBe("search-alias");
    expect(junk!.extras?.mapping).toBe("custom");

    // A real-but-unmapped attribute also lands in custom (graduatable later).
    expect(out.observations.find((o) => o.attributeCode === "custom.cpu_model")).toBeDefined();
  });

  test("preserves raw attribute keys when no vocabulary is loaded (legacy passthrough)", () => {
    const input: LinkAdapterInput = {
      ...flipkartSamsung,
      sku: {
        ...flipkartSamsung.sku,
        attributes: {
          "search-alias": { value: ["x"], unit: null, source: "structured" },
        },
      },
    };
    // makeCtx() supplies empty defs + synonyms → passthrough (unchanged behaviour).
    const out = linkAdapter.adapt(input, makeCtx());
    expect(out.observations.find((o) => o.attributeCode === "search-alias")).toBeDefined();
    expect(
      out.observations.find((o) => o.attributeCode === "custom.search_alias")
    ).toBeUndefined();
  });

  test("emits variant-level observations + pricing for a shoe with size+color", () => {
    const out = linkAdapter.adapt(
      amazonPegasus,
      makeCtx({ channelDefaultCurrency: "USD", channelDefaultLocale: "en_US" }),
    );

    // Parent title still present
    const title = out.observations.find(
      (o) => o.attributeCode === "title" && o.target === "parent",
    );
    expect(title).toBeDefined();
    expect(title!.channelCode).toBe("amazon-com");

    // Two variant pricing observations (one per variant)
    const variantPricing = out.pricingObservations.filter(
      (p) => p.variantAxes !== undefined,
    );
    expect(variantPricing.length).toBe(2);
    const blkPricing = variantPricing.find(
      (p) => p.variantAxes?.size === "8" && p.variantAxes?.color === "Black",
    );
    expect(blkPricing).toBeDefined();
    expect(blkPricing!.currency).toBe("USD");
    expect(blkPricing!.tiers).toEqual([
      { kind: "list", amount: 130 },
      { kind: "sale", amount: 99.95 },
    ]);
    expect(blkPricing!.sourceRecordId).toBe("DV3853-001-8-BLK");

    const whtPricing = variantPricing.find(
      (p) => p.variantAxes?.size === "9" && p.variantAxes?.color === "White",
    );
    expect(whtPricing).toBeDefined();
    expect(whtPricing!.tiers).toEqual([
      { kind: "list", amount: 130 },
      { kind: "sale", amount: 119.95 },
    ]);

    // Variant identity observations (sku, gtin) with variantAxes set
    const variantSkuObs = out.observations.filter(
      (o) => o.attributeCode === "identity.sku" && o.target === "variant",
    );
    expect(variantSkuObs.length).toBe(2);
    expect(variantSkuObs[0]!.variantAxes).toBeDefined();
    expect(variantSkuObs[0]!.variantAxes!.size).toBeDefined();
    expect(variantSkuObs[0]!.variantAxes!.color).toBeDefined();

    const variantGtinObs = out.observations.filter(
      (o) => o.attributeCode === "identity.gtin" && o.target === "variant",
    );
    expect(variantGtinObs.length).toBe(2);
    const blkGtin = variantGtinObs.find(
      (o) => o.variantAxes?.size === "8" && o.variantAxes?.color === "Black",
    );
    expect(blkGtin!.value).toBe("00194501234567");

    // identityHint flips to variant target
    expect(out.identityHint.targetIsVariant).toBe(true);
    expect(out.identityHint.brand).toBe("Nike");
  });

  test("no silent drops: ratings, seller, warranty, return_policy roundtrip as observations", () => {
    const out = linkAdapter.adapt(flipkartSamsung, makeCtx());

    // ratings: average + count surfaced (one observation with both in value or extras)
    const ratings = out.observations.find((o) => o.attributeCode === "ratings");
    expect(ratings).toBeDefined();
    expect((ratings!.value as { average: number; count: number }).average).toBe(4.6);
    expect((ratings!.value as { average: number; count: number }).count).toBe(28341);

    // seller name preserved
    const seller = out.observations.find((o) => o.attributeCode === "seller");
    expect(seller).toBeDefined();
    expect((seller!.value as { name: string }).name).toBe("RetailNet");

    // warranty + return_policy come through verbatim
    const warranty = out.observations.find((o) => o.attributeCode === "warranty");
    expect(warranty).toBeDefined();
    expect(warranty!.value).toBe("1 year manufacturer warranty");
    const returnPolicy = out.observations.find(
      (o) => o.attributeCode === "return_policy",
    );
    expect(returnPolicy).toBeDefined();
    expect(returnPolicy!.value).toBe("7-day replacement");

    // highlights array preserved
    const highlights = out.observations.find((o) => o.attributeCode === "highlights");
    expect(highlights).toBeDefined();
    expect(Array.isArray(highlights!.value)).toBe(true);
    expect((highlights!.value as string[]).length).toBe(3);

    // description_long preserved
    const desc = out.observations.find((o) => o.attributeCode === "description_long");
    expect(desc).toBeDefined();

    // category_path preserved with its confidence
    const category = out.observations.find((o) => o.attributeCode === "category_path");
    expect(category).toBeDefined();
    expect(category!.value).toBe("Mobiles > Smartphones");
    expect(category!.confidence).toBe(0.92);
    // Breadcrumbs and category_confidence land in extras (proves no silent drops)
    expect(category!.extras).toBeDefined();
    expect(category!.extras!.breadcrumbs).toEqual(["Mobiles", "Smartphones"]);

    // images preserved (one observation per image, or one with array; here: one observation)
    const images = out.observations.filter((o) => o.attributeCode === "images");
    expect(images.length).toBe(1);
    expect(Array.isArray(images[0]!.value)).toBe(true);
    expect((images[0]!.value as unknown[]).length).toBe(2);

    // shipping surfaced (proves shipping isn't dropped)
    const shipping = out.observations.find((o) => o.attributeCode === "shipping");
    expect(shipping).toBeDefined();
  });

  test("currency fallback: uses ctx.channelDefaultCurrency when sku.pricing.currency is null", () => {
    const noCurrencyInput: LinkAdapterInput = {
      ...flipkartSamsung,
      sku: {
        ...flipkartSamsung.sku,
        pricing: { ...flipkartSamsung.sku.pricing, currency: null },
      },
    };

    const out = linkAdapter.adapt(
      noCurrencyInput,
      makeCtx({ channelDefaultCurrency: "INR" }),
    );
    expect(out.pricingObservations[0]!.currency).toBe("INR");

    // Both null → throws
    expect(() =>
      linkAdapter.adapt(
        noCurrencyInput,
        makeCtx({ channelDefaultCurrency: null }),
      ),
    ).toThrow(/currency/i);
  });

  test("channelCodeFromUrl: amazon multi-tld, ebay, fallback to host-dot-replaced", () => {
    // amazon.com
    const usOut = linkAdapter.adapt(
      { ...amazonPegasus, sourceUrl: "https://www.amazon.com/foo/dp/B0X" },
      makeCtx({ channelDefaultCurrency: "USD" }),
    );
    expect(
      usOut.observations.find((o) => o.attributeCode === "title")!.channelCode,
    ).toBe("amazon-com");

    // amazon.com.au
    const auOut = linkAdapter.adapt(
      { ...amazonPegasus, sourceUrl: "https://www.amazon.com.au/foo/dp/B0X" },
      makeCtx({ channelDefaultCurrency: "AUD" }),
    );
    expect(
      auOut.observations.find((o) => o.attributeCode === "title")!.channelCode,
    ).toBe("amazon-com-au");

    // ebay.com.au
    const ebayOut = linkAdapter.adapt(
      { ...amazonPegasus, sourceUrl: "https://www.ebay.com.au/itm/123" },
      makeCtx({ channelDefaultCurrency: "AUD" }),
    );
    expect(
      ebayOut.observations.find((o) => o.attributeCode === "title")!.channelCode,
    ).toBe("ebay-com-au");

    // Unknown host fallback
    const otherOut = linkAdapter.adapt(
      { ...amazonPegasus, sourceUrl: "https://www.myshop.example.io/p/1" },
      makeCtx({ channelDefaultCurrency: "USD" }),
    );
    expect(
      otherOut.observations.find((o) => o.attributeCode === "title")!.channelCode,
    ).toBe("myshop-example-io");
  });
});
