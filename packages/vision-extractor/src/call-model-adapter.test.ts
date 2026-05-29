import { test, expect } from "bun:test";
import { createVisionCallModel } from "./call-model-adapter.js";
import type { VisionFetchImpl } from "./vision.js";

// Fake fetch returning a Groq-shaped chat response with two extracted facts.
// We test the adapter's SHAPE — it should turn ExtractedFact[] into the
// {field: {value, rawConfidence}} record genericExtract expects.
// Cast to VisionFetchImpl (= typeof fetch) because we only need the call
// signature; the static `preconnect` property isn't relevant in tests.
const fakeFetch = (async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              brand: "Google",
              base_price: 79999,
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as VisionFetchImpl;

test("adapter shape: returns {field: {value, rawConfidence}} keyed by rawKey", async () => {
  const callModel = createVisionCallModel({
    screenshotBase64: "AAAA",
    pageUrl: "https://example.com/p/123",
    deps: { apiKey: "test-key", fetchImpl: fakeFetch },
  });
  const out = await callModel(["brand", "base_price"], "ignored text");
  // Vision-extractor produces ExtractedFact entries with rawKey from the JSON
  // keys; the adapter maps each to {value, rawConfidence}.
  expect(out["brand"]).toBeDefined();
  expect(out["brand"]?.value).toBe("Google");
  expect(typeof out["brand"]?.rawConfidence).toBe("number");
  expect(out["base_price"]?.value).toBe(79999);
});

test("adapter ignores cleanedText (vision is image-based)", async () => {
  const callModel = createVisionCallModel({
    screenshotBase64: "AAAA",
    pageUrl: "https://example.com/x",
    deps: { apiKey: "test-key", fetchImpl: fakeFetch },
  });
  const a = await callModel(["brand"], "text A");
  const b = await callModel(["brand"], "completely different text B");
  // Same screenshot + same schema fields = same result regardless of text input
  expect(a["brand"]?.value).toBe(b["brand"]?.value);
});
