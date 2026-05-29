import { test, expect } from "bun:test";
import { canTransition, PRODUCT_STATES } from "./state-machine.js";

test("legal: staged -> active, active -> frozen_pending_review, frozen -> active", () => {
  expect(canTransition("staged", "active")).toBe(true);
  expect(canTransition("active", "frozen_pending_review")).toBe(true);
  expect(canTransition("frozen_pending_review", "active")).toBe(true);
});

test("illegal: merged is terminal; cannot leave it", () => {
  expect(canTransition("merged", "active")).toBe(false);
});

test("states are the canonical set", () => {
  expect(PRODUCT_STATES).toContain("active");
  expect(PRODUCT_STATES).toContain("merged");
});
