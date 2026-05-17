import { describe, it, expect } from "bun:test";
import { jaroWinkler } from "./jaro-winkler.js";

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("hello", "hello")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("returns 0 for empty input", () => {
    expect(jaroWinkler("", "x")).toBe(0);
    expect(jaroWinkler("x", "")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(jaroWinkler("HELLO", "hello")).toBe(1);
    expect(jaroWinkler("Aonami", "aonami")).toBe(1);
  });

  it("returns Wikipedia's canonical example for MARTHA vs MARHTA = 0.961", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961, 2);
  });

  it("returns Wikipedia's canonical example for DIXON vs DICKSONX = 0.813", () => {
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.813, 2);
  });

  it("scores Wikipedia's canonical example JELLYFISH vs SMELLYFISH ≈ 0.896", () => {
    expect(jaroWinkler("JELLYFISH", "SMELLYFISH")).toBeCloseTo(0.896, 2);
  });

  it("scores product titles realistically (similar titles)", () => {
    const s1 = "Sony WH-1000XM5 Wireless Noise-Canceling Headphones";
    const s2 = "Sony WH-1000XM5 Wireless Noise Canceling Headphones (Black)";
    expect(jaroWinkler(s1, s2)).toBeGreaterThan(0.85);
  });

  it("scores product titles realistically (different products)", () => {
    const s1 = "Sony WH-1000XM5 Wireless Headphones";
    const s2 = "Apple AirPods Pro 2nd Generation";
    expect(jaroWinkler(s1, s2)).toBeLessThan(0.65);
  });
});
