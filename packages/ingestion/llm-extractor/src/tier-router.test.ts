import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { pickModel, decideTextBudget } from "./tier-router.js";

describe("pickModel", () => {
  let savedLight: string | undefined;
  let savedHeavy: string | undefined;
  beforeEach(() => {
    savedLight = process.env["GROQ_MODEL_GAP_FILL_LIGHT"];
    savedHeavy = process.env["GROQ_MODEL_GAP_FILL_HEAVY"];
    delete process.env["GROQ_MODEL_GAP_FILL_LIGHT"];
    delete process.env["GROQ_MODEL_GAP_FILL_HEAVY"];
  });
  afterEach(() => {
    if (savedLight !== undefined) process.env["GROQ_MODEL_GAP_FILL_LIGHT"] = savedLight; else delete process.env["GROQ_MODEL_GAP_FILL_LIGHT"];
    if (savedHeavy !== undefined) process.env["GROQ_MODEL_GAP_FILL_HEAVY"] = savedHeavy; else delete process.env["GROQ_MODEL_GAP_FILL_HEAVY"];
  });

  it("uses LIGHT model when ≤3 gaps + JSON-LD + small page", () => {
    const m = pickModel({ gaps: ["title","brand","gtin"], hasJsonLd: true, cleanedTextLen: 20_000 });
    expect(m.model).toBe("llama-3.1-8b-instant");
    expect(m.maxTokens).toBe(800);
  });

  it("uses HEAVY model when many gaps", () => {
    const m = pickModel({ gaps: Array.from({ length: 10 }, (_, i) => `g${i}`), hasJsonLd: true, cleanedTextLen: 20_000 });
    expect(m.model).toBe("llama-3.3-70b-versatile");
    expect(m.maxTokens).toBe(2_000);
  });

  it("uses HEAVY model when no JSON-LD", () => {
    const m = pickModel({ gaps: ["title"], hasJsonLd: false, cleanedTextLen: 20_000 });
    expect(m.model).toBe("llama-3.3-70b-versatile");
  });

  it("uses HEAVY model when page is huge (>=50KB)", () => {
    const m = pickModel({ gaps: ["title"], hasJsonLd: true, cleanedTextLen: 60_000 });
    expect(m.model).toBe("llama-3.3-70b-versatile");
  });

  it("honors env override for LIGHT", () => {
    process.env["GROQ_MODEL_GAP_FILL_LIGHT"] = "custom-light";
    const m = pickModel({ gaps: ["t","b","g"], hasJsonLd: true, cleanedTextLen: 10_000 });
    expect(m.model).toBe("custom-light");
  });

  it("honors env override for HEAVY", () => {
    process.env["GROQ_MODEL_GAP_FILL_HEAVY"] = "custom-heavy";
    const m = pickModel({ gaps: Array.from({ length: 10 }, (_, i) => `g${i}`), hasJsonLd: true, cleanedTextLen: 10_000 });
    expect(m.model).toBe("custom-heavy");
  });
});

describe("decideTextBudget", () => {
  it("returns 5000 when coverage ≥ 0.7", () => expect(decideTextBudget(0.75)).toBe(5_000));
  it("returns 15000 when 0.4 ≤ coverage < 0.7", () => expect(decideTextBudget(0.5)).toBe(15_000));
  it("returns 30000 when coverage < 0.4", () => expect(decideTextBudget(0.2)).toBe(30_000));
  it("returns 30000 for 0 coverage", () => expect(decideTextBudget(0)).toBe(30_000));
});
