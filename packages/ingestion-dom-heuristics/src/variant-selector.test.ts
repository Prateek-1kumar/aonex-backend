import { describe, expect, it } from "bun:test";
import { extractVariantSelectorFromDom } from "./variant-selector.js";

describe("extractVariantSelectorFromDom", () => {
  it("extracts size options from a <select name='size'>", () => {
    const html = `<html><body>
      <select name="size">
        <option value="S">Small</option>
        <option value="M">Medium</option>
        <option value="L">Large</option>
      </select>
    </body></html>`;
    const facts = extractVariantSelectorFromDom(html);
    expect(facts.length).toBe(1);
    expect(facts[0]!.rawKey).toBe("size");
    expect(facts[0]!.extractedValue).toEqual(["S", "M", "L"]);
    expect(facts[0]!.confidence).toBe(0.65);
    expect(facts[0]!.sourcePointer).toBe("dom_heuristic:select[name=size]");
    expect(facts[0]!.extractionMethod).toBe("inferred");
  });

  it("extracts color options from radio buttons grouped by name", () => {
    const html = `<html><body>
      <input type="radio" name="color" value="red">
      <input type="radio" name="color" value="blue">
      <input type="radio" name="color" value="green">
    </body></html>`;
    const facts = extractVariantSelectorFromDom(html);
    expect(facts.length).toBe(1);
    expect(facts[0]!.rawKey).toBe("color");
    expect(facts[0]!.extractedValue).toEqual(["red", "blue", "green"]);
    expect(facts[0]!.confidence).toBe(0.65);
    expect(facts[0]!.sourcePointer).toBe("dom_heuristic:radio[name=color]");
  });
});
