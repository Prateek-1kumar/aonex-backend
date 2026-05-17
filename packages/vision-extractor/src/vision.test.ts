import { describe, it, expect } from "bun:test";
import { callVision, VISION_EXTRACTOR_VERSION } from "./vision.js";

function makeStubFetch(opts: {
  status?: number;
  jsonBody?: unknown;
  textBody?: string;
}): typeof fetch {
  return (async () => {
    const status = opts.status ?? 200;
    if (opts.jsonBody !== undefined) {
      return new Response(JSON.stringify(opts.jsonBody), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(opts.textBody ?? "", { status });
  }) as never;
}

describe("callVision", () => {
  const input = {
    screenshotBase64: "iVBOR....",
    pageUrl: "https://shop.example/p/123"
  };
  const deps = { apiKey: "test-key" };

  it("returns parsed facts from a successful vision response", async () => {
    const stubFetch = makeStubFetch({
      jsonBody: {
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Test Product",
              brand: "TestBrand",
              base_price: 99.99,
              color: "Red"
            })
          }
        }],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
        model: "llama-3.2-90b-vision-preview"
      }
    });
    const result = await callVision(input, { ...deps, fetchImpl: stubFetch });
    expect(result.facts).toHaveLength(4);
    expect(result.facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Test Product");
    expect(result.facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(99.99);
    expect(result.modelVersion).toBe(VISION_EXTRACTOR_VERSION);
    expect(result.promptTokens).toBe(1000);
    expect(result.completionTokens).toBe(50);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("assigns vision confidence (0.70) to every fact", async () => {
    const stubFetch = makeStubFetch({
      jsonBody: {
        choices: [{ message: { content: JSON.stringify({ color: "Blue" }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      }
    });
    const result = await callVision(input, { ...deps, fetchImpl: stubFetch });
    expect(result.facts[0]!.confidence).toBe(0.70);
  });

  it("returns empty facts when the model returns malformed JSON", async () => {
    const stubFetch = makeStubFetch({
      jsonBody: {
        choices: [{ message: { content: "not json{}{" } }],
        usage: { prompt_tokens: 100, completion_tokens: 5 }
      }
    });
    const result = await callVision(input, { ...deps, fetchImpl: stubFetch });
    expect(result.facts).toEqual([]);
    expect(result.promptTokens).toBe(100);
  });

  it("skips null/empty values in the response", async () => {
    const stubFetch = makeStubFetch({
      jsonBody: {
        choices: [{
          message: {
            content: JSON.stringify({ title: "X", brand: null, color: "" })
          }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      }
    });
    const result = await callVision(input, { ...deps, fetchImpl: stubFetch });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.rawKey).toBe("title");
  });

  it("throws on non-2xx API response", async () => {
    const stubFetch = makeStubFetch({ status: 401, textBody: "Invalid API key" });
    await expect(callVision(input, { ...deps, fetchImpl: stubFetch })).rejects.toThrow(/Vision API error 401/);
  });

  it("passes the screenshot as a data URI in the image_url field", async () => {
    let capturedBody: string | null = null;
    const stubFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as never;
    await callVision({ ...input, screenshotBase64: "MOCKBASE64" }, { ...deps, fetchImpl: stubFetch });
    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody!) as { messages: Array<{ role: string; content: unknown }> };
    const userMessage = parsed.messages[1];
    expect(userMessage?.role).toBe("user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const imagePart = (userMessage?.content as Array<{ type: string; image_url?: { url: string } }>).find((c) => c.type === "image_url");
    expect(imagePart?.image_url?.url).toBe("data:image/png;base64,MOCKBASE64");
  });

  it("uses default Groq model when not overridden", async () => {
    let capturedBody: string | null = null;
    const stubFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: {}
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as never;
    await callVision(input, { ...deps, fetchImpl: stubFetch });
    const parsed = JSON.parse(capturedBody!) as { model: string };
    expect(parsed.model).toBe("llama-3.2-90b-vision-preview");
  });

  it("respects model override", async () => {
    let capturedBody: string | null = null;
    const stubFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: {}
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as never;
    await callVision(input, { ...deps, fetchImpl: stubFetch, model: "llama-3.2-11b-vision-preview" });
    const parsed = JSON.parse(capturedBody!) as { model: string };
    expect(parsed.model).toBe("llama-3.2-11b-vision-preview");
  });
});
