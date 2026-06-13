import { describe, expect, test } from "bun:test";
import { selectEnrichProvider, selectEnrichChain } from "./llm-provider-select.js";

describe("selectEnrichProvider", () => {
  test("returns null when no provider key is set", () => {
    expect(selectEnrichProvider({})).toBeNull();
  });

  test("prefers Gemini over Groq and OpenAI when its key is set", () => {
    const r = selectEnrichProvider({
      GEMINI_API_KEY: "gm",
      GROQ_API_KEY: "gq",
      OPENAI_API_KEY: "oa",
    });
    expect(r?.provider).toBe("gemini");
    expect(r?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(r?.model).toBe("gemini-2.0-flash");
    expect(r?.fallbackModels).toEqual([]); // no per-model TPD wall
  });

  test("honors Gemini base-url + model overrides", () => {
    const r = selectEnrichProvider({
      GEMINI_API_KEY: "gm",
      GEMINI_BASE_URL: "https://proxy.example/v1",
      GEMINI_MODEL_ENRICH: "gemini-2.0-flash",
    });
    expect(r?.baseUrl).toBe("https://proxy.example/v1");
    expect(r?.model).toBe("gemini-2.0-flash");
  });

  test("falls back to Groq with a fallback model when only Groq is set", () => {
    const r = selectEnrichProvider({ GROQ_API_KEY: "gq", GROQ_MODEL_ENRICH: "llama-x" });
    expect(r?.provider).toBe("groq");
    expect(r?.model).toBe("llama-x");
    expect(r?.fallbackModels).toEqual(["llama-3.1-8b-instant"]);
  });

  test("falls back to OpenAI when only OpenAI is set", () => {
    const r = selectEnrichProvider({ OPENAI_API_KEY: "oa" });
    expect(r?.provider).toBe("openai");
    expect(r?.baseUrl).toBe("https://api.openai.com/v1");
    expect(r?.model).toBe("gpt-4o-mini");
  });
});

describe("selectEnrichChain", () => {
  test("returns all configured providers in precedence order", () => {
    const chain = selectEnrichChain({ GEMINI_API_KEY: "gm", GROQ_API_KEY: "gq", OPENAI_API_KEY: "oa" });
    expect(chain.map((s) => s.provider)).toEqual(["gemini", "groq", "openai"]);
  });

  test("skips providers with no key (Gemini + Groq only)", () => {
    const chain = selectEnrichChain({ GEMINI_API_KEY: "gm", GROQ_API_KEY: "gq" });
    expect(chain.map((s) => s.provider)).toEqual(["gemini", "groq"]);
  });

  test("empty when nothing configured", () => {
    expect(selectEnrichChain({})).toEqual([]);
  });
});
