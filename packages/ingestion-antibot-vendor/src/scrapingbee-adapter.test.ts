import { describe, it, expect } from "bun:test";
import { createScrapingBeeAdapter, type ScrapingBeeClient } from "./scrapingbee-adapter.js";

function makeStub(responseInit: {
  body: string;
  costHeader?: string;
  resolvedUrl?: string;
}): { client: ScrapingBeeClient; calls: Array<{ url: string; params: Record<string, unknown> }> } {
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  const client: ScrapingBeeClient = {
    async get({ url, params }) {
      calls.push({ url, params });
      return {
        data: Buffer.from(responseInit.body, "utf-8"),
        headers: {
          "spb-cost": responseInit.costHeader ?? "1",
          "spb-resolved-url": responseInit.resolvedUrl ?? url
        }
      };
    }
  };
  return { client, calls };
}

describe("createScrapingBeeAdapter.unblock", () => {
  it("returns rawHtml from response.data", async () => {
    const { client } = makeStub({ body: "<html>hi</html>" });
    const adapter = createScrapingBeeAdapter(client);
    const result = await adapter.unblock("https://example.com/");
    expect(result.rawHtml).toBe("<html>hi</html>");
  });

  it("parses spb-cost header into costCredits", async () => {
    const { client } = makeStub({ body: "ok", costHeader: "42" });
    const adapter = createScrapingBeeAdapter(client);
    const result = await adapter.unblock("https://example.com/");
    expect(result.costCredits).toBe(42);
  });

  it("uses spb-resolved-url as finalUrl when present", async () => {
    const { client } = makeStub({ body: "ok", resolvedUrl: "https://final.example/path" });
    const adapter = createScrapingBeeAdapter(client);
    const result = await adapter.unblock("https://requested.example/");
    expect(result.finalUrl).toBe("https://final.example/path");
  });

  it("falls back to requested URL if spb-resolved-url header is missing", async () => {
    const client: ScrapingBeeClient = {
      async get() {
        return {
          data: Buffer.from("ok"),
          headers: { "spb-cost": "1" }    // no spb-resolved-url
        };
      }
    };
    const adapter = createScrapingBeeAdapter(client);
    const result = await adapter.unblock("https://example.com/");
    expect(result.finalUrl).toBe("https://example.com/");
  });

  it("forwards options to the SDK params object", async () => {
    const { client, calls } = makeStub({ body: "ok" });
    const adapter = createScrapingBeeAdapter(client);
    await adapter.unblock("https://example.com/", {
      premiumProxy: true,
      jsRendering: false,
      countryCode: "de"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual({
      render_js: false,
      premium_proxy: true,
      country_code: "de"
    });
  });

  it("defaults render_js=true and country_code=us", async () => {
    const { client, calls } = makeStub({ body: "ok" });
    const adapter = createScrapingBeeAdapter(client);
    await adapter.unblock("https://example.com/");
    expect(calls[0]!.params).toEqual({
      render_js: true,
      premium_proxy: false,
      country_code: "us"
    });
  });
});
