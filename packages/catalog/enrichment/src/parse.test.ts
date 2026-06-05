// Parsing must tolerate the `null`-for-absent-optional pattern LLMs emit.
// Regression: Groq returned `"unit": null` for unit-less candidates, which the
// strict `.optional()` schema rejected and failed the whole proposal.

import { test, expect } from "bun:test";
import { parseEnrichmentResponse } from "./parse.js";

test("accepts null for absent optional candidate fields (unit/label/reasoning)", () => {
  const raw = JSON.stringify({
    fields: {
      material: { value: "cotton", confidence: 0.9, reasoning: null },
    },
    candidates: [
      { key: "rise", label: "Rise", dataType: "string", value: "mid", unit: null, enumCandidates: null, reasoning: "matters for jeans" },
      { key: "distressing", label: null, dataType: null, value: "light", unit: null, reasoning: null },
    ],
    content_quality: { score: 82, coherence: 8, spelling: null, consistency: 9, relevance: null },
  });

  const parsed = parseEnrichmentResponse(raw);

  // null is normalized to undefined (absent), not a validation error.
  expect(parsed.candidates).toHaveLength(2);
  expect(parsed.candidates[0]!.unit).toBeUndefined();
  expect(parsed.candidates[0]!.enumCandidates).toBeUndefined();
  expect(parsed.candidates[1]!.label).toBeUndefined();
  expect(parsed.fields.material!.reasoning).toBeUndefined();
  expect(parsed.content_quality?.score).toBe(82);
});

test("malformed content_quality degrades to absent instead of failing", () => {
  const raw = JSON.stringify({
    candidates: [{ key: "color", value: "blue" }],
    content_quality: { score: null }, // required field nulled → drop the block, keep the proposal
  });

  const parsed = parseEnrichmentResponse(raw);
  expect(parsed.content_quality).toBeUndefined();
  expect(parsed.candidates).toHaveLength(1);
});
