import { describe, expect, test } from "bun:test";
import { csvAdapter, adaptGroups, inspectCsv, type CsvAdapterInput } from "./index.js";
import type { AdaptContext } from "../types.js";

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

const HEADER =
  "primary_identifier,gtin,mpn,brand,title,category,description_long,currency,list_price,sale_price,weight_value,weight_unit,variant_color,variant_size,variant_gtin,variant_sku,variant_inventory_qty";

function makeInput(csv: string, overrides: Partial<CsvAdapterInput> = {}): CsvAdapterInput {
  return {
    csv,
    filename: "shomed-products-2026-05.csv",
    observedAt: "2026-05-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("csvAdapter", () => {
  test("parent-only row emits parent observations + a single pricing observation", () => {
    const csv = [
      HEADER,
      `SHO-001,08901234567890,MPN-SHO-001,Shomed,"Shomed Pain Balm 50g","Health > Topicals","A long description of the balm.",AUD,12.99,9.99,50,g,,,,,`,
    ].join("\n");

    const out = csvAdapter.adapt(makeInput(csv), makeCtx());

    // Title (channel-scoped, defaults to "csv")
    const title = out.observations.find(
      (o) => o.attributeCode === "title" && o.target === "parent",
    );
    expect(title).toBeDefined();
    expect(title!.value).toBe("Shomed Pain Balm 50g");
    expect(title!.channelCode).toBe("csv");
    expect(title!.localeCode).toBe("en_AU");
    expect(title!.source).toBe("csv:shomed-products-2026-05.csv");
    expect(title!.observedAt.toISOString()).toBe("2026-05-21T10:00:00.000Z");
    expect(title!.sourceRecordId).toBe("SHO-001");

    // Brand at _unscoped/_unscoped
    const brand = out.observations.find((o) => o.attributeCode === "brand");
    expect(brand).toBeDefined();
    expect(brand!.target).toBe("parent");
    expect(brand!.channelCode).toBe("_unscoped");
    expect(brand!.localeCode).toBe("_unscoped");
    expect(brand!.value).toBe("Shomed");

    // identity.gtin at _unscoped/_unscoped
    const gtin = out.observations.find((o) => o.attributeCode === "identity.gtin");
    expect(gtin).toBeDefined();
    expect(gtin!.target).toBe("parent");
    expect(gtin!.channelCode).toBe("_unscoped");
    expect(gtin!.localeCode).toBe("_unscoped");
    expect(gtin!.value).toBe("08901234567890");

    // identity.mpn at _unscoped
    const mpn = out.observations.find((o) => o.attributeCode === "identity.mpn");
    expect(mpn).toBeDefined();
    expect(mpn!.channelCode).toBe("_unscoped");
    expect(mpn!.value).toBe("MPN-SHO-001");

    // category channel-scoped
    const category = out.observations.find((o) => o.attributeCode === "category");
    expect(category).toBeDefined();
    expect(category!.value).toBe("Health > Topicals");
    expect(category!.channelCode).toBe("csv");

    // description_long channel-scoped
    const desc = out.observations.find((o) => o.attributeCode === "description_long");
    expect(desc).toBeDefined();
    expect(desc!.value).toBe("A long description of the balm.");

    // weight with unit in extras
    const weight = out.observations.find((o) => o.attributeCode === "weight");
    expect(weight).toBeDefined();
    expect(weight!.value).toBe(50);
    expect((weight!.extras as { unit: string }).unit).toBe("g");

    // Exactly one parent observation each — no duplicates
    const parentObs = out.observations.filter((o) => o.target === "parent");
    expect(parentObs.length).toBe(7); // title, brand, identity.mpn, identity.gtin, category, description_long, weight
    // No variant observations
    expect(out.observations.filter((o) => o.target === "variant").length).toBe(0);

    // Single pricing observation (list + sale tiers, row currency)
    expect(out.pricingObservations.length).toBe(1);
    const pricing = out.pricingObservations[0]!;
    expect(pricing.currency).toBe("AUD");
    expect(pricing.channelCode).toBe("csv");
    expect(pricing.tiers).toEqual([
      { kind: "list", amount: 12.99 },
      { kind: "sale", amount: 9.99 },
    ]);
    expect(pricing.productHint).toBe("SHO-001");
    expect(pricing.variantAxes).toBeUndefined();

    // No inventory observations (no variant_inventory_qty)
    expect(out.inventoryObservations.length).toBe(0);

    // Identity hint
    expect(out.identityHint.gtin).toBe("08901234567890");
    expect(out.identityHint.mpn).toBe("MPN-SHO-001");
    expect(out.identityHint.brand).toBe("Shomed");
    expect(out.identityHint.titleForFuzzy).toBe("Shomed Pain Balm 50g");
    expect(out.identityHint.targetIsVariant).toBe(false);
  });

  test("multi-row variants share one parent: parent fields emit ONCE per primary_identifier", () => {
    const csv = [
      HEADER,
      `NK-PEG,8806095269757,DV3853-001,Nike,"Nike Pegasus 40","Shoes > Running","Daily trainer.",USD,130,99.95,0.8,kg,Black,8,8806095269758,NK-PEG-40-BLK-8,12`,
      `NK-PEG,,,,,,,,,,,,Black,9,8806095269759,NK-PEG-40-BLK-9,5`,
      `NK-PEG,,,,,,,,,,,,White,9,8806095269760,NK-PEG-40-WHT-9,3`,
    ].join("\n");

    const out = csvAdapter.adapt(
      makeInput(csv),
      makeCtx({ channelDefaultCurrency: "USD", channelDefaultLocale: "en_US" }),
    );

    // Parent obs emitted ONCE despite 3 rows
    const parentObs = out.observations.filter((o) => o.target === "parent");
    // title, brand, identity.mpn, identity.gtin, category, description_long, weight = 7
    expect(parentObs.length).toBe(7);

    // Exactly one title
    const titles = out.observations.filter(
      (o) => o.attributeCode === "title" && o.target === "parent",
    );
    expect(titles.length).toBe(1);
    expect(titles[0]!.value).toBe("Nike Pegasus 40");

    // Exactly one brand, gtin, mpn
    expect(out.observations.filter((o) => o.attributeCode === "brand").length).toBe(1);
    expect(
      out.observations.filter(
        (o) => o.attributeCode === "identity.gtin" && o.target === "parent",
      ).length,
    ).toBe(1);
    expect(out.observations.filter((o) => o.attributeCode === "identity.mpn").length).toBe(1);

    // 3 variant identity.sku observations
    const variantSku = out.observations.filter(
      (o) => o.attributeCode === "identity.sku" && o.target === "variant",
    );
    expect(variantSku.length).toBe(3);
    expect(variantSku[0]!.channelCode).toBe("csv");
    expect(variantSku[0]!.variantAxes).toEqual({ color: "Black", size: "8" });
    expect(variantSku[0]!.value).toBe("NK-PEG-40-BLK-8");
    expect(variantSku[1]!.variantAxes).toEqual({ color: "Black", size: "9" });
    expect(variantSku[2]!.variantAxes).toEqual({ color: "White", size: "9" });

    // 3 variant identity.gtin observations at _unscoped
    const variantGtin = out.observations.filter(
      (o) => o.attributeCode === "identity.gtin" && o.target === "variant",
    );
    expect(variantGtin.length).toBe(3);
    for (const obs of variantGtin) {
      expect(obs.channelCode).toBe("_unscoped");
      expect(obs.localeCode).toBe("_unscoped");
    }

    // 3 inventory observations
    expect(out.inventoryObservations.length).toBe(3);
    expect(out.inventoryObservations[0]!.qty).toBe(12);
    expect(out.inventoryObservations[1]!.qty).toBe(5);
    expect(out.inventoryObservations[2]!.qty).toBe(3);
    expect(out.inventoryObservations[0]!.productHint).toBe("NK-PEG");
    expect(out.inventoryObservations[0]!.variantAxes).toEqual({
      color: "Black",
      size: "8",
    });

    // Pricing: 1 parent + 3 variants (variants inherit parent tiers/currency in v1)
    expect(out.pricingObservations.length).toBe(4);
    const variantPricing = out.pricingObservations.filter(
      (p) => p.variantAxes !== undefined,
    );
    expect(variantPricing.length).toBe(3);
    for (const p of variantPricing) {
      expect(p.currency).toBe("USD");
      expect(p.tiers).toEqual([
        { kind: "list", amount: 130 },
        { kind: "sale", amount: 99.95 },
      ]);
    }

    // Identity hint flips to variant target
    expect(out.identityHint.targetIsVariant).toBe(true);
    expect(out.identityHint.brand).toBe("Nike");
    expect(out.identityHint.gtin).toBe("8806095269757");
  });

  test("missing required column (no primary_identifier header) throws", () => {
    const csv = [
      "gtin,title,brand",
      "1234567890123,Foo,Bar",
    ].join("\n");

    expect(() => csvAdapter.adapt(makeInput(csv), makeCtx())).toThrow(
      /missing required column "primary_identifier"/,
    );
  });

  test("empty primary_identifier on a data row throws with row number", () => {
    const csv = [
      HEADER,
      `SHO-001,,,Shomed,"Row one",,,AUD,10,,,,,,,,`,
      `,,,Shomed,"Row two",,,AUD,10,,,,,,,,`, // empty primary_identifier on row 2
    ].join("\n");

    expect(() => csvAdapter.adapt(makeInput(csv), makeCtx())).toThrow(
      /row 2: empty primary_identifier/,
    );
  });

  test("currency fallback: row blank uses ctx.channelDefaultCurrency; both blank throws", () => {
    const csvBlankCurrency = [
      HEADER,
      `SHO-001,,,Shomed,"Shomed Balm",,,,12.99,9.99,,,,,,,`, // currency column empty
    ].join("\n");

    // Row blank but ctx has default → uses default
    const out = csvAdapter.adapt(
      makeInput(csvBlankCurrency),
      makeCtx({ channelDefaultCurrency: "INR" }),
    );
    expect(out.pricingObservations.length).toBe(1);
    expect(out.pricingObservations[0]!.currency).toBe("INR");

    // Both blank → throws
    expect(() =>
      csvAdapter.adapt(
        makeInput(csvBlankCurrency),
        makeCtx({ channelDefaultCurrency: null }),
      ),
    ).toThrow(/currency missing/i);
  });
});

// HEADER column order:
// primary_identifier,gtin,mpn,brand,title,category,description_long,currency,
// list_price,sale_price,weight_value,weight_unit,variant_color,variant_size,
// variant_gtin,variant_sku,variant_inventory_qty   (17 columns)
describe("csvAdapter.adaptGroups", () => {
  test("emits one group per primary_identifier and collects bad groups without throwing", () => {
    const csv = [HEADER,
      "P1,,,Acme,Widget,,,USD,,,,,,,,,",      // valid: brand + title
      "P2,,,,,,,USD,,,,,,,,,",                 // invalid: neither title nor brand
      ",,,Acme,Orphan,,,USD,,,,,,,,,",         // invalid: empty primary_identifier
    ].join("\n");
    const res = adaptGroups(makeInput(csv), makeCtx());
    expect(res.groups.map((g) => g.primaryIdentifier)).toEqual(["P1"]);
    expect(res.errors.map((e) => e.code).sort()).toEqual(["EMPTY_PRIMARY_IDENTIFIER", "GROUP_VALIDATION_FAILED"]);
    expect(res.rowCount).toBe(3);
  });

  test("cleans money formatting in prices", () => {
    const csv = [HEADER, "P1,,,Acme,Widget,,,USD,\"$1,299.00\",,,,,,,,"].join("\n");
    const res = adaptGroups(makeInput(csv), makeCtx());
    const price = res.groups[0]!.output.pricingObservations[0]!;
    expect(price.tiers[0]!.amount).toBe(1299);
  });

  test("warns on unrecognized headers with a suggestion", () => {
    const badHeader = HEADER.replace("primary_identifier", "primary_identifer,primary_identifier");
    const csv = [badHeader, "x,P1,,,Acme,Widget,,,USD,,,,,,,,,"].join("\n");
    const res = adaptGroups(makeInput(csv), makeCtx());
    expect(res.warnings.some((w) => w.code === "UNKNOWN_COLUMN" && /did you mean "primary_identifier"/.test(w.message))).toBe(true);
  });
});

describe("csvAdapter.inspectCsv", () => {
  test("returns headers + rowCount, throws on missing required column", () => {
    const ok = inspectCsv([HEADER, "P1,,,Acme,Widget,,,USD,,,,,,,,,"].join("\n"));
    expect(ok.rowCount).toBe(1);
    expect(ok.headers).toContain("primary_identifier");
    expect(() => inspectCsv("foo,bar\n1,2")).toThrow(/missing required column/);
  });
});
