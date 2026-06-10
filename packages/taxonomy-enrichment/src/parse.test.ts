import { describe, expect, test } from "bun:test";
import { EnrichmentParseError, parseEnrichmentResponse } from "./parse.js";

describe("parseEnrichmentResponse", () => {
  test("parses fenced JSON and normalizes fields", () => {
    const raw = "```json\n" + JSON.stringify({
      fields: {
        color: { value: "Black", confidence: 0.9, evidence: "Black", inferred: false },
        os: { value: "iOS", confidence: 95, inferred: true },
      },
      candidates: [{ key: "water_resistance", label: "Water Resistance", dataType: "string", value: "IP68" }],
    }) + "\n```";
    const out = parseEnrichmentResponse(raw);
    expect(out.fields).toHaveLength(2);
    const os = out.fields.find((f) => f.key === "os")!;
    expect(os.confidence).toBe(0.95); // 95 -> 0.95
    expect(os.inferred).toBe(true);
    expect(out.candidates[0]!.key).toBe("water_resistance");
  });

  test("tolerates null confidence/evidence", () => {
    const out = parseEnrichmentResponse(JSON.stringify({
      fields: { brand: { value: "Sony", confidence: null, evidence: null, reasoning: null } },
    }));
    expect(out.fields[0]!.confidence).toBe(0.5); // neutral default
    expect(out.fields[0]!.evidence).toBeUndefined();
  });

  test("extracts the JSON object from surrounding prose", () => {
    const out = parseEnrichmentResponse('Sure! Here you go: {"fields":{"x":{"value":1,"confidence":0.5}}} done');
    expect(out.fields[0]!.key).toBe("x");
  });

  test("throws on non-JSON", () => {
    expect(() => parseEnrichmentResponse("not json at all")).toThrow(EnrichmentParseError);
  });
});
