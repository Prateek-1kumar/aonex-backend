import { test, expect } from "bun:test";
import { isAnemicResponse } from "./fetch-escalation.js";

// Padding helper: keeps test fixtures readable while letting them clear the
// 5KB and 30KB guards we want to test independently of byte-size.
const pad = (n: number): string => "<!-- ".concat("filler ".repeat(n), " -->");

test("a tiny page is still anemic by the size guard (existing behavior preserved)", () => {
  const html = "<html><head><title>Croma</title></head><body><div id='root'></div></body></html>";
  expect(isAnemicResponse(html)).toBe(true);
});

test("a real PDP with Product JSON-LD is NOT anemic", () => {
  const html = `<html><head><title>Pixel 10</title></head><body>${pad(2000)}` +
    `<script type="application/ld+json">{"@type":"Product","name":"Pixel 10","offers":{"price":"79999","priceCurrency":"INR"}}</script>` +
    `<div id="content">${pad(2000)}</div></body></html>`;
  expect(isAnemicResponse(html)).toBe(false);
});

test("a >30KB JS shell with non-Product JSON-LD only is anemic (new escalation trigger)", () => {
  // Existing logic: hasJsonLd is true (Organization counts), length >= 30KB → not anemic → never escalates → Croma class bug.
  // New logic: no Product-typed JSON-LD AND empty app root → anemic → escalates to browser.
  const html = `<html><head><title>Croma</title></head><body>${pad(8000)}` +
    `<script type="application/ld+json">{"@type":"Organization","name":"Croma"}</script>` +
    `<div id="__next"></div>${pad(8000)}</body></html>`;
  expect(html.length).toBeGreaterThan(30_000); // sanity: clears the existing 30KB short-circuit
  expect(isAnemicResponse(html)).toBe(true);
});
