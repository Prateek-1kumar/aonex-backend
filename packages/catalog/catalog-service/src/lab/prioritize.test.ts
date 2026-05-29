import { test, expect } from "bun:test";
import { prioritize } from "./prioritize.js";

test("higher price + fewer missing fields ranks first (closest to publishable, most value)", () => {
  const ordered = prioritize([
    { id: "a", price: 1000,  missingCount: 3, ageHours: 1 },
    { id: "b", price: 90000, missingCount: 1, ageHours: 1 },
  ]);
  expect(ordered[0]!.id).toBe("b");
});

test("age breaks ties so nothing starves", () => {
  const ordered = prioritize([
    { id: "old", price: 1000, missingCount: 1, ageHours: 100 },
    { id: "new", price: 1000, missingCount: 1, ageHours: 1 },
  ]);
  expect(ordered[0]!.id).toBe("old");
});
