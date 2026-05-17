import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./index.js";

const fixtureDir = join(import.meta.dir, "fixtures");
const tentsSchema = JSON.parse(readFileSync(join(fixtureDir, "tents.schema.json"), "utf-8"));
const mobilesSchema = JSON.parse(readFileSync(join(fixtureDir, "mobile-phones.schema.json"), "utf-8"));
const umbrellasSchema = JSON.parse(readFileSync(join(fixtureDir, "umbrellas.schema.json"), "utf-8"));

describe("validate — Tier 1 strict (tents)", () => {
  it("accepts a tent with all required attributes", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 2,
      season_rating: "3-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000,
      color: "Green"
    });
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("flags missing required season_rating", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 2,
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000
    });
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain("season_rating");
  });

  it("rejects out-of-range integer", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 99,
      season_rating: "3-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "/capacity_persons")).toBe(true);
  });

  it("rejects enum value outside allowed list", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 2,
      season_rating: "2-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "/season_rating")).toBe(true);
  });
});

describe("validate — Tier 1 strict (mobile_phones)", () => {
  it("accepts a complete iPhone", () => {
    const result = validate(mobilesSchema, {
      ram_gb: 8,
      storage_gb: 256,
      screen_size_inches: 6.1,
      os: "iOS 17",
      battery_mah: 3274,
      network_type: "5G"
    });
    expect(result.valid).toBe(true);
  });

  it("flags missing required battery_mah and network_type", () => {
    const result = validate(mobilesSchema, {
      ram_gb: 8,
      storage_gb: 256,
      screen_size_inches: 6.1,
      os: "iOS 17"
    });
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toEqual(
      expect.arrayContaining(["battery_mah", "network_type"])
    );
  });
});

describe("validate — Tier 2 permissive (umbrellas)", () => {
  it("accepts arbitrary attributes when schema has empty required[]", () => {
    const result = validate(umbrellasSchema, {
      color: "Black",
      opening_mechanism: "automatic",
      frame_material: "fiberglass",
      canopy_diameter_cm: 105
    });
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("accepts an empty attributes object on Tier 2", () => {
    const result = validate(umbrellasSchema, {});
    expect(result.valid).toBe(true);
  });
});
