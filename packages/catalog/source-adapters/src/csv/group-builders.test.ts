import { describe, expect, test } from "bun:test";
import {
  buildCustomAttrs,
  buildImages,
  buildParentObservations,
  buildParentPricing,
  buildVariants,
  type CsvRowIssue,
  type GroupShared,
  type IndexedRow,
} from "./group-builders.js";

const OBSERVED_AT = new Date("2026-01-15T00:00:00Z");

function mkShared(overrides: Partial<GroupShared> = {}): GroupShared {
  return {
    channelCode: "csv",
    locale: "_unscoped",
    source: "csv:test.csv",
    observedAt: OBSERVED_AT,
    channelDefaultCurrency: "USD",
    warnings: [],
    ...overrides,
  };
}

const rows = (...rs: Record<string, string>[]): IndexedRow[] =>
  rs.map((row, i) => ({ row, index: i + 1 }));

describe("buildParentObservations", () => {
  test("consolidates first non-empty across the group, scoping identity fields", () => {
    const { observations, fields } = buildParentObservations(
      "P1",
      rows({ title: "", brand: "Acme" }, { title: "Acme Jeans", gtin: "00012345678905" }),
      mkShared()
    );
    expect(fields).toEqual({ title: "Acme Jeans", brand: "Acme", gtin: "00012345678905" });
    const byCode = Object.fromEntries(observations.map((o) => [o.attributeCode, o]));
    expect(byCode.title).toMatchObject({ channelCode: "csv", confidence: 0.85 });
    expect(byCode.brand).toMatchObject({ channelCode: "_unscoped", confidence: 0.9 });
    expect(byCode["identity.gtin"]).toMatchObject({ channelCode: "_unscoped" });
  });

  test("throws when the group has neither title nor brand", () => {
    expect(() => buildParentObservations("P1", rows({ mpn: "M-1" }), mkShared())).toThrow(
      /neither title nor brand/
    );
  });

  test("warns on a bad GTIN but still emits the observation", () => {
    const warnings: CsvRowIssue[] = [];
    const { observations } = buildParentObservations(
      "P1",
      rows({ title: "T", gtin: "12345678" }), // bad check digit
      mkShared({ warnings })
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("INVALID_GTIN");
    expect(observations.some((o) => o.attributeCode === "identity.gtin")).toBe(true);
  });

  test("emits weight with unit extras", () => {
    const { observations } = buildParentObservations(
      "P1",
      rows({ title: "T", weight_value: "1,5", weight_unit: "kg" }),
      mkShared()
    );
    const weight = observations.find((o) => o.attributeCode === "weight")!;
    expect(weight.value).toBe(1.5);
    expect(weight.extras).toEqual({ unit: "kg" });
  });
});

describe("buildParentPricing", () => {
  test("builds list+sale tiers with the channel default currency", () => {
    const { pricing, tiers, currency } = buildParentPricing(
      "P1",
      rows({ list_price: "99.99", sale_price: "79.99" }),
      mkShared()
    );
    expect(tiers).toEqual([
      { kind: "list", amount: 99.99 },
      { kind: "sale", amount: 79.99 },
    ]);
    expect(currency).toBe("USD");
    expect(pricing).toHaveLength(1);
  });

  test("throws when priced but no currency is resolvable", () => {
    expect(() =>
      buildParentPricing("P1", rows({ list_price: "10" }), mkShared({ channelDefaultCurrency: null }))
    ).toThrow(/currency missing/);
  });

  test("no price columns -> no pricing observation", () => {
    const { pricing, tiers } = buildParentPricing("P1", rows({ title: "T" }), mkShared());
    expect(pricing).toEqual([]);
    expect(tiers).toEqual([]);
  });
});

describe("buildVariants", () => {
  const parent = { pricing: [], tiers: [{ kind: "list" as const, amount: 50 }], currency: "EUR" };

  test("variant rows inherit parent pricing unless they carry their own", () => {
    const { observations, pricing, inventory } = buildVariants(
      "P1",
      rows(
        { variant_sku: "S-RED", variant_color: "Red" },
        { variant_sku: "S-BLUE", variant_color: "Blue", variant_list_price: "60", variant_currency: "GBP" }
      ),
      parent,
      mkShared()
    );
    expect(observations.map((o) => o.value)).toEqual(["S-RED", "S-BLUE"]);
    expect(pricing[0]).toMatchObject({ currency: "EUR", tiers: [{ kind: "list", amount: 50 }] });
    expect(pricing[1]).toMatchObject({ currency: "GBP", tiers: [{ kind: "list", amount: 60 }] });
    expect(inventory).toEqual([]);
  });

  test("non-variant rows are skipped; inventory rows parse qty", () => {
    const { observations, inventory } = buildVariants(
      "P1",
      rows({ title: "parent only" }, { variant_sku: "S1", variant_inventory_qty: "7" }),
      parent,
      mkShared()
    );
    expect(observations).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ qty: 7, variantAxes: {} });
  });
});

describe("buildImages", () => {
  test("dedupes by URL, preferring the entry with variant alt text", () => {
    const obs = buildImages(
      "P1",
      rows(
        { image_url: "https://x/a.jpg" },
        { variant_color: "Red", variant_image_url: "https://x/a.jpg, https://x/b.jpg" }
      ),
      mkShared()
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.value).toEqual([
      { url: "https://x/a.jpg", altText: "Color: Red" },
      { url: "https://x/b.jpg", altText: "Color: Red" },
    ]);
  });

  test("warns on a non-URL value but still passes it through", () => {
    const warnings: CsvRowIssue[] = [];
    const obs = buildImages("P1", rows({ image_url: "not-a-url" }), mkShared({ warnings }));
    expect(warnings[0]!.code).toBe("INVALID_IMAGE_URL");
    expect(obs[0]!.value).toEqual([{ url: "not-a-url" }]);
  });

  test("no image columns -> no observation", () => {
    expect(buildImages("P1", rows({ title: "T" }), mkShared())).toEqual([]);
  });
});

describe("buildCustomAttrs", () => {
  test("emits custom.<col> for each populated custom column", () => {
    const obs = buildCustomAttrs(
      "P1",
      rows({ season: "SS26", fabric: "" }, { fabric: "denim" }),
      ["season", "fabric"],
      mkShared()
    );
    expect(obs.map((o) => [o.attributeCode, o.value])).toEqual([
      ["custom.season", "SS26"],
      ["custom.fabric", "denim"],
    ]);
  });
});
