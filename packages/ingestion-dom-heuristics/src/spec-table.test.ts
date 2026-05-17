import { describe, expect, it } from "bun:test";
import { extractSpecTableFromDom } from "./spec-table.js";

describe("extractSpecTableFromDom", () => {
  it("extracts facts from a two-column <table> with th+td rows", () => {
    const html = `<html><body>
      <table>
        <tr><th>Capacity</th><td>2 person</td></tr>
        <tr><th>Weight</th><td>5 kg</td></tr>
      </table>
    </body></html>`;
    const facts = extractSpecTableFromDom(html);
    expect(facts.length).toBe(2);
    const capacity = facts.find((f) => f.rawKey === "capacity");
    expect(capacity).toBeDefined();
    expect(capacity!.extractedValue).toBe("2 person");
    expect(capacity!.confidence).toBe(0.70);
    expect(capacity!.extractionMethod).toBe("inferred");
    const weight = facts.find((f) => f.rawKey === "weight");
    expect(weight).toBeDefined();
    expect(weight!.extractedValue).toBe("5 kg");
  });

  it("extracts facts from <dl>/<dt>/<dd> definition lists", () => {
    const html = `<html><body>
      <dl>
        <dt>Color</dt><dd>Midnight Black</dd>
        <dt>Material</dt><dd>Aluminum</dd>
      </dl>
    </body></html>`;
    const facts = extractSpecTableFromDom(html);
    expect(facts.length).toBe(2);
    const color = facts.find((f) => f.rawKey === "color");
    expect(color).toBeDefined();
    expect(color!.extractedValue).toBe("Midnight Black");
    expect(color!.confidence).toBe(0.70);
    const material = facts.find((f) => f.rawKey === "material");
    expect(material).toBeDefined();
    expect(material!.extractedValue).toBe("Aluminum");
  });

  it("returns empty array for empty HTML", () => {
    const facts = extractSpecTableFromDom("<html><body></body></html>");
    expect(facts).toEqual([]);
  });
});
