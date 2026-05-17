import { describe, it, expect, afterAll } from "bun:test";
import { fetchWithBrowser, closeBrowserPool } from "./playwright-pool.js";

const haveBrowser = process.env["PLAYWRIGHT_INTEGRATION"] === "1";

(haveBrowser ? describe : describe.skip)("fetchWithBrowser — integration", () => {
  afterAll(async () => {
    await closeBrowserPool();
  });

  it("fetches a static page and returns HTML", async () => {
    const result = await fetchWithBrowser("https://example.com/");
    expect(result.statusCode).toBe(200);
    expect(result.rawHtml).toContain("Example Domain");
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.fetchDurationMs).toBeGreaterThan(0);
  }, 30_000);

  it("respects timeoutMs", async () => {
    // This URL is intentionally slow / unresponsive (replace with a known slow test URL if needed)
    try {
      await fetchWithBrowser("https://httpbin.org/delay/30", { timeoutMs: 2_000 });
      expect.unreachable("Should have thrown on timeout");
    } catch (err) {
      expect(err instanceof Error).toBe(true);
    }
  }, 10_000);
});
