import { describe, it, expect } from "bun:test";
import { canonicalizeUrl, domainOf } from "./url.js";

describe("canonicalizeUrl", () => {
  it("strips utm_* params", () => {
    expect(
      canonicalizeUrl(
        "https://example.com/p/abc?utm_source=fb&utm_medium=cpc&keep=1"
      )
    ).toBe("https://example.com/p/abc?keep=1");
  });

  it("strips fbclid, gclid, mc_eid", () => {
    expect(
      canonicalizeUrl("https://example.com/p?fbclid=x&gclid=y&mc_eid=z")
    ).toBe("https://example.com/p");
  });

  it("normalizes trailing slash on path", () => {
    expect(canonicalizeUrl("https://example.com/page/")).toBe(
      "https://example.com/page"
    );
  });

  it("preserves root trailing slash", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("lowercases host but preserves path case", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/Path/Item")).toBe(
      "https://example.com/Path/Item"
    );
  });

  it("strips Amazon-style tracking refs", () => {
    expect(
      canonicalizeUrl(
        "https://amazon.in/dp/B0FK5GSGLW/ref=sr_1_6?crid=abc&dib=xyz"
      )
    ).toBe("https://amazon.in/dp/B0FK5GSGLW");
  });

  it("preserves fragment if it is a variant id", () => {
    expect(
      canonicalizeUrl("https://www.asos.com/au/p/prd/209522202#colourWayId-209522203")
    ).toBe("https://www.asos.com/au/p/prd/209522202#colourWayId-209522203");
  });

  it("returns input unchanged if not a valid URL", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("domainOf", () => {
  it("returns hostname without www", () => {
    expect(domainOf("https://www.bewakoof.com/p/foo")).toBe("bewakoof.com");
  });

  it("lowercases hostname", () => {
    expect(domainOf("https://WWW.Example.COM/x")).toBe("example.com");
  });

  it("returns subdomains intact except www", () => {
    expect(domainOf("https://shop.brand.com/p")).toBe("shop.brand.com");
    expect(domainOf("https://www.amazon.in/dp/x")).toBe("amazon.in");
  });

  it("returns empty string on invalid input", () => {
    expect(domainOf("not a url")).toBe("");
  });
});
