import { describe, expect, test } from "bun:test";
import {
  shopifyConnectorAdapter,
  channelCodeFromShopDomain,
  type ShopifyAdapterInput,
} from "./index.js";
import type { AdaptContext } from "../types.js";
import nikePegasusJson from "./__fixtures__/nike-pegasus.json" with { type: "json" };

const nikePegasus = nikePegasusJson as unknown as ShopifyAdapterInput;

function makeCtx(overrides: Partial<AdaptContext> = {}): AdaptContext {
  return {
    tenantId: "t1" as any,
    channelId: "ch1" as any,
    channelDefaultCurrency: "AUD",
    channelDefaultLocale: "en_AU",
    attributeDefinitions: [],
    attributeSynonyms: [],
    ...overrides,
  };
}

describe("shopifyConnectorAdapter", () => {
  test("parent + variants emitted correctly for a Shopify product", () => {
    const out = shopifyConnectorAdapter.adapt(nikePegasus, makeCtx());

    // Title scoped to derived channel
    const title = out.observations.find(
      (o) => o.attributeCode === "title" && o.target === "parent",
    );
    expect(title).toBeDefined();
    expect(title!.channelCode).toBe("shopify-au");
    expect(title!.value).toContain("Nike Pegasus");
    expect(title!.source).toBe("shopify:connector");
    expect(title!.observedAt.toISOString()).toBe("2026-05-21T10:00:00.000Z");
    // handle preserved in extras so it isn't dropped
    expect((title!.extras as { handle: string }).handle).toBe("nike-pegasus-40");

    // Brand at _unscoped (from vendor)
    const brand = out.observations.find((o) => o.attributeCode === "brand");
    expect(brand).toBeDefined();
    expect(brand!.target).toBe("parent");
    expect(brand!.channelCode).toBe("_unscoped");
    expect(brand!.localeCode).toBe("_unscoped");
    expect(brand!.value).toBe("Nike");

    // Category path (low-confidence hint from productType)
    const category = out.observations.find((o) => o.attributeCode === "category_path");
    expect(category).toBeDefined();
    expect(category!.value).toBe("Running Shoes");
    expect(category!.confidence).toBe(0.5);
    expect(category!.channelCode).toBe("shopify-au");

    // tags: single observation holding the array
    const tags = out.observations.filter((o) => o.attributeCode === "tags");
    expect(tags.length).toBe(1);
    expect(tags[0]!.value).toEqual(["men", "running", "pegasus", "nike"]);

    // body_html → description_long
    const desc = out.observations.find((o) => o.attributeCode === "description_long");
    expect(desc).toBeDefined();
    expect(desc!.value).toContain("Air Zoom");

    // status preserved
    const status = out.observations.find((o) => o.attributeCode === "status");
    expect(status).toBeDefined();
    expect(status!.value).toBe("ACTIVE");

    // options preserved
    const options = out.observations.find((o) => o.attributeCode === "options");
    expect(options).toBeDefined();
    expect(Array.isArray(options!.value)).toBe(true);

    // images preserved (single observation, holds array)
    const images = out.observations.filter((o) => o.attributeCode === "images");
    expect(images.length).toBe(1);
    expect(Array.isArray(images[0]!.value)).toBe(true);

    // Two variant pricing observations (one per variant)
    expect(out.pricingObservations.length).toBe(2);
    // Two inventory observations
    expect(out.inventoryObservations.length).toBe(2);
    expect(out.inventoryObservations[0]!.qty).toBe(12);
    expect(out.inventoryObservations[1]!.qty).toBe(5);

    // Pricing with list+compare for variant 1
    const blkPricing = out.pricingObservations.find(
      (p) => p.variantAxes?.color === "Black" && p.variantAxes?.size === "8",
    );
    expect(blkPricing).toBeDefined();
    expect(blkPricing!.currency).toBe("AUD");
    expect(blkPricing!.tiers).toEqual([
      { kind: "list", amount: 129.99 },
      { kind: "compare", amount: 159.99 },
    ]);
    // productHint prefers barcode
    expect(blkPricing!.productHint).toBe("8806095269757");

    // Variant identity observations (sku, gtin)
    const variantSkuObs = out.observations.filter(
      (o) => o.attributeCode === "identity.sku" && o.target === "variant",
    );
    expect(variantSkuObs.length).toBe(2);
    expect(variantSkuObs[0]!.channelCode).toBe("shopify-au");

    const variantGtinObs = out.observations.filter(
      (o) => o.attributeCode === "identity.gtin" && o.target === "variant",
    );
    expect(variantGtinObs.length).toBe(2);
    expect(variantGtinObs[0]!.channelCode).toBe("_unscoped");
    expect(variantGtinObs[0]!.localeCode).toBe("_unscoped");

    // weight observations (with kg unit in extras)
    const weightObs = out.observations.filter((o) => o.attributeCode === "weight");
    expect(weightObs.length).toBe(2);
    expect(weightObs[0]!.value).toBe(0.8);
    expect((weightObs[0]!.extras as { unit: string }).unit).toBe("kg");

    // Identity hint
    expect(out.identityHint.brand).toBe("Nike");
    expect(out.identityHint.titleForFuzzy).toContain("Nike Pegasus");
    expect(out.identityHint.targetIsVariant).toBe(true);
    expect(out.identityHint.gtin).toBe("8806095269757");

    // Raw payload echoed back
    expect(out.rawPayload).toBe(nikePegasus.product);
  });

  test("variant axes correctly extracted from selectedOptions", () => {
    const out = shopifyConnectorAdapter.adapt(nikePegasus, makeCtx());

    // Every variant-target observation has both axes set
    const variantObs = out.observations.filter((o) => o.target === "variant");
    expect(variantObs.length).toBeGreaterThan(0);
    for (const obs of variantObs) {
      expect(obs.variantAxes).toBeDefined();
      expect(obs.variantAxes!.color).toBeDefined();
      expect(obs.variantAxes!.size).toBeDefined();
    }

    // Specific values for variant 1
    const blkSku = out.observations.find(
      (o) =>
        o.attributeCode === "identity.sku" &&
        o.target === "variant" &&
        o.variantAxes?.color === "Black",
    );
    expect(blkSku).toBeDefined();
    expect(blkSku!.variantAxes).toEqual({ color: "Black", size: "8" });
    expect(blkSku!.value).toBe("NK-PEG-40-BLK-8");

    // Pricing + inventory carry the same axes
    const whtPricing = out.pricingObservations.find(
      (p) => p.variantAxes?.color === "White",
    );
    expect(whtPricing).toBeDefined();
    expect(whtPricing!.variantAxes).toEqual({ color: "White", size: "9" });
    const whtInv = out.inventoryObservations.find(
      (i) => i.variantAxes?.color === "White",
    );
    expect(whtInv).toBeDefined();
    expect(whtInv!.variantAxes).toEqual({ color: "White", size: "9" });
  });

  test("no compareAtPrice → pricing observation has only list tier", () => {
    const out = shopifyConnectorAdapter.adapt(nikePegasus, makeCtx());

    // Second variant (White / 9) has no compareAtPrice
    const whtPricing = out.pricingObservations.find(
      (p) => p.variantAxes?.color === "White",
    );
    expect(whtPricing).toBeDefined();
    expect(whtPricing!.tiers).toEqual([{ kind: "list", amount: 129.99 }]);
    expect(whtPricing!.tiers.find((t) => t.kind === "compare")).toBeUndefined();
  });

  test("currency derived from ctx.channelDefaultCurrency for every pricing observation", () => {
    const out = shopifyConnectorAdapter.adapt(
      nikePegasus,
      makeCtx({ channelDefaultCurrency: "USD" }),
    );

    expect(out.pricingObservations.length).toBe(2);
    for (const p of out.pricingObservations) {
      expect(p.currency).toBe("USD");
    }

    // Missing ctx currency → throws (Shopify variants don't carry currency)
    expect(() =>
      shopifyConnectorAdapter.adapt(
        nikePegasus,
        makeCtx({ channelDefaultCurrency: null }),
      ),
    ).toThrow(/currency/i);
  });

  test("channel-code derivation: *.myshopify.com → shopify-au", () => {
    expect(channelCodeFromShopDomain("demo-shop.myshopify.com")).toBe("shopify-au");
    expect(channelCodeFromShopDomain("another.myshopify.com")).toBe("shopify-au");
    // Custom domains also default to shopify-au — channel id already scopes per-tenant
    expect(channelCodeFromShopDomain("shop.example.com")).toBe("shopify-au");

    // End-to-end: every channel-scoped observation uses the derived code
    const out = shopifyConnectorAdapter.adapt(nikePegasus, makeCtx());
    const channelScoped = out.observations.filter(
      (o) => o.channelCode !== "_unscoped",
    );
    expect(channelScoped.length).toBeGreaterThan(0);
    for (const obs of channelScoped) {
      expect(obs.channelCode).toBe("shopify-au");
    }
    for (const p of out.pricingObservations) {
      expect(p.channelCode).toBe("shopify-au");
    }
    for (const i of out.inventoryObservations) {
      expect(i.channelCode).toBe("shopify-au");
    }
  });
});
