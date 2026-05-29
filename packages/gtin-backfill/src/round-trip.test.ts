import { test, expect } from "bun:test";
import { roundTripMatches } from "./round-trip.js";

test("accepts when looked-up title+brand match our product", () => {
  expect(roundTripMatches(
    { title: "Google Pixel 10 5G", brand: "Google" },
    { title: "Pixel 10 5G", brand: "google" }
  )).toBe(true);
});

test("rejects when the registry returns a different product", () => {
  expect(roundTripMatches(
    { title: "Google Pixel 10", brand: "Google" },
    { title: "Samsung Galaxy S25", brand: "Samsung" }
  )).toBe(false);
});
