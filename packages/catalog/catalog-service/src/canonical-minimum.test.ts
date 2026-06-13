// Pins the locked v1 CANONICAL_MINIMUM required-field list against drift.

import { test, expect } from "bun:test";
import { CANONICAL_MINIMUM } from "./canonical-minimum.js";

test("CANONICAL_MINIMUM is the locked v1 required-field list", () => {
  expect(CANONICAL_MINIMUM).toEqual([
    "title",
    "brand",
    "pricing.primary",
    "category_path",
    "identifier"
  ]);
});
