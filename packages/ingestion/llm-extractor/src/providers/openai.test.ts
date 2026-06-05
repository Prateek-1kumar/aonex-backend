// Retry/backoff contract for OpenAIProvider (also covers Groq via baseUrl).
// Groq's on-demand TPM limit returns 429 with a Retry-After; the provider must
// honor it and retry transient errors rather than failing the enrichment job.

import { test, expect } from "bun:test";
import { OpenAIProvider } from "./openai.js";

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  model: "llama-3.3-70b-versatile",
});

const PARAMS = {
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 100,
  temperature: 0,
  jsonMode: true,
};

/** Swap in a fake global fetch for the duration of `fn`, then restore it. */
async function withFetch<T>(impl: () => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test("retries on 429 (honoring Retry-After) then succeeds", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: "k" });
  const result = await withFetch(
    async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limit reached ... Please try again in 0.01s", code: "rate_limit_exceeded" },
          }),
          { status: 429, headers: { "retry-after": "0" } }
        );
      }
      return new Response(OK_BODY, { status: 200 });
    },
    () => provider.chatCompletion(PARAMS)
  );
  expect(calls).toBe(2);
  expect(result.content).toBe('{"ok":true}');
});

test("does not retry a non-retryable 400", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: "k" });
  await expect(
    withFetch(
      async () => {
        calls++;
        return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
      },
      () => provider.chatCompletion(PARAMS)
    )
  ).rejects.toThrow("OpenAI API error (400)");
  expect(calls).toBe(1);
});

test("exhausts retries on persistent 429 and throws the last error", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: "k", maxRetries: 2 });
  await expect(
    withFetch(
      async () => {
        calls++;
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      },
      () => provider.chatCompletion(PARAMS)
    )
  ).rejects.toThrow("OpenAI API error (429)");
  expect(calls).toBe(3); // 1 initial attempt + 2 retries
});
