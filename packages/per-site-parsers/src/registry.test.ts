import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerParser,
  findParserForUrl,
  listRegisteredParsers,
  _resetRegistry
} from "./registry.js";

const stubParser = (overrides: Partial<{
  domains: string[];
  priority: number;
  fingerprint: string;
  requiresBrowser: boolean;
}>) => ({
  domains: overrides.domains ?? ["example.com"],
  priority: overrides.priority ?? 100,
  fingerprint: overrides.fingerprint ?? "v1",
  requiresBrowser: overrides.requiresBrowser ?? false,
  extract: async () => []
});

beforeEach(() => _resetRegistry());

describe("findParserForUrl", () => {
  it("returns null when no parser matches", () => {
    expect(findParserForUrl("https://nowhere.example/x")).toBeNull();
  });

  it("matches exact hostname", () => {
    registerParser(stubParser({ domains: ["amazon.com"] }));
    expect(findParserForUrl("https://amazon.com/dp/B01")?.domains).toEqual(["amazon.com"]);
  });

  it("matches subdomain via suffix (www.amazon.com → amazon.com)", () => {
    registerParser(stubParser({ domains: ["amazon.com"] }));
    expect(findParserForUrl("https://www.amazon.com/dp/B01")?.domains).toEqual(["amazon.com"]);
  });

  it("matches case-insensitively (UPPERCASE hostname)", () => {
    registerParser(stubParser({ domains: ["amazon.com"] }));
    expect(findParserForUrl("https://WWW.AMAZON.COM/dp/B01")?.domains).toEqual(["amazon.com"]);
  });

  it("higher priority wins when multiple parsers match the same domain", () => {
    registerParser(stubParser({ domains: ["amazon.com"], priority: 50, fingerprint: "low" }));
    registerParser(stubParser({ domains: ["amazon.com"], priority: 200, fingerprint: "high" }));
    expect(findParserForUrl("https://amazon.com/dp/B01")?.fingerprint).toBe("high");
  });

  it("returns null for malformed URLs", () => {
    expect(findParserForUrl("not-a-url")).toBeNull();
    expect(findParserForUrl("")).toBeNull();
  });

  it("does NOT match a partial substring (amazon.commerce should not match amazon.com)", () => {
    registerParser(stubParser({ domains: ["amazon.com"] }));
    // "amazon.commerce" does NOT end in ".amazon.com" and is not exactly "amazon.com" → no match.
    expect(findParserForUrl("https://amazon.commerce/x")).toBeNull();
  });
});

describe("listRegisteredParsers", () => {
  it("returns parsers sorted by priority descending", () => {
    registerParser(stubParser({ domains: ["a.com"], priority: 10, fingerprint: "low" }));
    registerParser(stubParser({ domains: ["b.com"], priority: 100, fingerprint: "high" }));
    registerParser(stubParser({ domains: ["c.com"], priority: 50, fingerprint: "mid" }));
    const list = listRegisteredParsers();
    expect(list.map((p) => p.fingerprint)).toEqual(["high", "mid", "low"]);
  });

  it("returns a defensive copy (caller mutation does not affect registry)", () => {
    registerParser(stubParser({ domains: ["a.com"] }));
    const list = listRegisteredParsers();
    expect(list).toHaveLength(1);
    // Cast to mutable to test defensive-copy guarantee
    (list as Array<unknown>).length = 0;
    expect(listRegisteredParsers()).toHaveLength(1);
  });
});
