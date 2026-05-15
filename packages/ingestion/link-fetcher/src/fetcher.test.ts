import { describe, it, expect } from "bun:test";
import { fetchLink } from "./fetcher.js";

describe("fetchLink (canonicalization)", () => {
  it("strips tracking params before fetching", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response("<html><body>ok</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
    }) as typeof fetch;

    try {
      await fetchLink(
        "https://example.com/p?utm_source=fb&utm_medium=cpc&id=1"
      );
      expect(calls[0]).toBe("https://example.com/p?id=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
