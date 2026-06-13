// Tests for FallbackChatProvider: primary success, failover on error, and
// surfacing the last error when every provider in the chain fails.

import { describe, expect, test } from "bun:test";
import { FallbackChatProvider } from "./fallback-chat-provider.js";
import type { ChatProvider } from "./chat-provider.js";

const params = { messages: [], maxTokens: 100, temperature: 0, jsonMode: true, model: "ignored" };

function ok(content: string): ChatProvider & { calls: string[] } {
  const p = {
    calls: [] as string[],
    async chatCompletion(args: { model: string }) {
      p.calls.push(args.model);
      return { content, model: args.model };
    },
  };
  return p;
}
function boom(message: string): ChatProvider & { calls: string[] } {
  const p = {
    calls: [] as string[],
    async chatCompletion(args: { model: string }) {
      p.calls.push(args.model);
      throw new Error(message);
    },
  };
  return p;
}

describe("FallbackChatProvider", () => {
  test("uses the primary when it succeeds (fallback untouched)", async () => {
    const primary = ok("from-gemini");
    const fallback = ok("from-groq");
    const r = await new FallbackChatProvider([
      { provider: primary, model: "gemini-2.0-flash", label: "gemini" },
      { provider: fallback, model: "llama-3.3-70b", label: "groq" },
    ]).chatCompletion(params);
    expect(r.content).toBe("from-gemini");
    expect(primary.calls).toEqual(["gemini-2.0-flash"]);
    expect(fallback.calls).toEqual([]);
  });

  test("fails over to the next provider on a primary error (the 429 case)", async () => {
    const primary = boom("OpenAI API error (429): quota exceeded");
    const fallback = ok("from-groq");
    const r = await new FallbackChatProvider([
      { provider: primary, model: "gemini-2.0-flash", label: "gemini" },
      { provider: fallback, model: "llama-3.3-70b", label: "groq" },
    ]).chatCompletion(params);
    expect(r.content).toBe("from-groq");
    expect(fallback.calls).toEqual(["llama-3.3-70b"]);
  });

  test("throws the last error when every provider fails", async () => {
    const p = new FallbackChatProvider([
      { provider: boom("429"), model: "a" },
      { provider: boom("final boom"), model: "b" },
    ]);
    await expect(p.chatCompletion(params)).rejects.toThrow("final boom");
  });
});
