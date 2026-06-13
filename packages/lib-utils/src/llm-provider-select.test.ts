import { describe, expect, test } from "bun:test";
import { selectEnrichProvider } from "./llm-provider-select.js";

describe("selectEnrichProvider", () => {
  test("returns null when no provider key is set", () => {
    expect(selectEnrichProvider({})).toBeNull();
  });

  test("prefers DeepSeek over Groq and OpenAI when its key is set", () => {
    const r = selectEnrichProvider({
      DEEPSEEK_API_KEY: "ds",
      GROQ_API_KEY: "gq",
      OPENAI_API_KEY: "oa",
    });
    expect(r?.provider).toBe("deepseek");
    expect(r?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(r?.model).toBe("deepseek-chat");
    expect(r?.fallbackModels).toEqual([]); // no per-model TPD wall
  });

  test("honors DeepSeek base-url + model overrides", () => {
    const r = selectEnrichProvider({
      DEEPSEEK_API_KEY: "ds",
      DEEPSEEK_BASE_URL: "https://proxy.example/v1",
      DEEPSEEK_MODEL_ENRICH: "deepseek-reasoner",
    });
    expect(r?.baseUrl).toBe("https://proxy.example/v1");
    expect(r?.model).toBe("deepseek-reasoner");
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
