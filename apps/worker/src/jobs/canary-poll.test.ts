import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCanaryPoll } from "./canary-poll.js";
import type { PerSiteParser } from "@aonex/per-site-parsers";

function makeTempFixtures(retailers: Array<{
  name: string;
  config: { domain: string; urls: string[]; expectedFields: string[] };
}>): string {
  const dir = join(tmpdir(), `canary-poll-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const r of retailers) {
    const sub = join(dir, r.name);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "canary-urls.json"), JSON.stringify(r.config));
  }
  return dir;
}

function fakeFetcher(htmlByUrl: Record<string, string>): typeof import("@aonex/ingestion-link-fetcher").fetchLink {
  return (async (url: string) => {
    if (!(url in htmlByUrl)) {
      throw new Error("ENOTFOUND");
    }
    return {
      url,
      finalUrl: url,
      statusCode: 200,
      contentType: "text/html",
      rawHtml: htmlByUrl[url]!,
      cleanedText: "",
      structuredBlocks: { jsonLd: [], nextData: null, apolloState: null, initialState: null },
      captchaSignal: false,
      fetchedAt: new Date(),
      contentChecksum: "x"
    };
  }) as never;
}

function fakeParser(facts: Array<{ rawKey: string }>): PerSiteParser {
  return {
    domains: ["example.com"],
    priority: 100,
    fingerprint: "test@1.0",
    requiresBrowser: false,
    extract: async () => facts.map((f) => ({
      rawKey: f.rawKey,
      canonicalPath: null,
      extractedValue: "x",
      normalizedValue: null,
      unit: null,
      sourcePointer: "test",
      extractionMethod: "direct" as const,
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: 0.9,
      approved: false
    }))
  };
}

describe("runCanaryPoll", () => {
  it("returns empty result when fixtures dir is missing", async () => {
    const result = await runCanaryPoll({ fixturesDir: "/nonexistent/path" });
    expect(result.retailers).toEqual([]);
    expect(result.overallPassRate).toBe(1.0);
  });

  it("samples URLs per retailer (up to 5)", async () => {
    const dir = makeTempFixtures([{
      name: "demo",
      config: {
        domain: "example.com",
        urls: ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
        expectedFields: ["title"]
      }
    }]);
    try {
      const result = await runCanaryPoll({
        fixturesDir: dir,
        fetcher: fakeFetcher({
          "https://example.com/1": "<html>...</html>",
          "https://example.com/2": "<html>...</html>",
          "https://example.com/3": "<html>...</html>"
        }),
        findParser: () => fakeParser([{ rawKey: "title" }])
      });
      expect(result.retailers).toHaveLength(1);
      expect(result.retailers[0]!.sampled).toBe(3);
      expect(result.retailers[0]!.passed).toBe(3);
      expect(result.overallPassRate).toBe(1.0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags missing fields", async () => {
    const dir = makeTempFixtures([{
      name: "demo",
      config: {
        domain: "example.com",
        urls: ["https://example.com/1"],
        expectedFields: ["title", "base_price"]
      }
    }]);
    try {
      const result = await runCanaryPoll({
        fixturesDir: dir,
        fetcher: fakeFetcher({ "https://example.com/1": "<html></html>" }),
        findParser: () => fakeParser([{ rawKey: "title" }])    // base_price missing
      });
      expect(result.retailers[0]!.passed).toBe(0);
      expect(result.retailers[0]!.failed[0]!.reason).toContain("missing_fields:base_price");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags fetch errors per URL without aborting the loop", async () => {
    const dir = makeTempFixtures([{
      name: "demo",
      config: {
        domain: "example.com",
        urls: ["https://example.com/1", "https://example.com/2"],
        expectedFields: ["title"]
      }
    }]);
    try {
      const result = await runCanaryPoll({
        fixturesDir: dir,
        fetcher: fakeFetcher({ "https://example.com/1": "<html></html>" }),    // /2 throws ENOTFOUND
        findParser: () => fakeParser([{ rawKey: "title" }])
      });
      expect(result.retailers[0]!.passed).toBe(1);
      expect(result.retailers[0]!.failed).toHaveLength(1);
      expect(result.retailers[0]!.failed[0]!.url).toBe("https://example.com/2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags URLs with no matching parser", async () => {
    const dir = makeTempFixtures([{
      name: "demo",
      config: {
        domain: "example.com",
        urls: ["https://example.com/1"],
        expectedFields: ["title"]
      }
    }]);
    try {
      const result = await runCanaryPoll({
        fixturesDir: dir,
        fetcher: fakeFetcher({ "https://example.com/1": "<html></html>" }),
        findParser: () => null
      });
      expect(result.retailers[0]!.passed).toBe(0);
      expect(result.retailers[0]!.failed[0]!.reason).toBe("no_parser_matched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computes overall pass rate across retailers", async () => {
    const dir = makeTempFixtures([
      {
        name: "good",
        config: {
          domain: "good.com",
          urls: ["https://good.com/1", "https://good.com/2"],
          expectedFields: ["title"]
        }
      },
      {
        name: "bad",
        config: {
          domain: "bad.com",
          urls: ["https://bad.com/1"],
          expectedFields: ["title"]
        }
      }
    ]);
    try {
      const result = await runCanaryPoll({
        fixturesDir: dir,
        fetcher: fakeFetcher({
          "https://good.com/1": "<html></html>",
          "https://good.com/2": "<html></html>",
          "https://bad.com/1": "<html></html>"
        }),
        // good retailer's URLs return the parser; bad retailer's URLs do not
        findParser: (url) => url.includes("good.com") ? fakeParser([{ rawKey: "title" }]) : null
      });
      // 2 passes (good.com), 1 fail (bad.com) = 2/3 pass rate
      expect(result.overallPassRate).toBeCloseTo(2 / 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips retailer with no canary-urls.json", async () => {
    const dir = makeTempFixtures([]);
    const sub = join(dir, "no-canary");
    mkdirSync(sub);
    try {
      const result = await runCanaryPoll({ fixturesDir: dir });
      expect(result.retailers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips retailer with malformed canary-urls.json", async () => {
    const dir = join(tmpdir(), `canary-malformed-${Date.now()}`);
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "canary-urls.json"), "{ not json");
    try {
      const result = await runCanaryPoll({ fixturesDir: dir });
      expect(result.retailers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
