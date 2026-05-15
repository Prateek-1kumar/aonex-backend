import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanHtml } from "@aonex/ingestion-link-fetcher";
import { extractStructured } from "./index.js";

const decathlon = readFileSync(
  join(__dirname, "../test/fixtures/decathlon.html"),
  "utf8"
);
const bewakoof = readFileSync(
  join(__dirname, "../test/fixtures/bewakoof.html"),
  "utf8"
);
const captcha = readFileSync(
  join(__dirname, "../test/fixtures/amazon-captcha.html"),
  "utf8"
);

describe("extractStructured (integration)", () => {
  it("Decathlon → full coverage from JSON-LD, no LLM needed", async () => {
    const { structuredBlocks } = cleanHtml(decathlon);
    const out = await extractStructured({
      pageUrl: "https://www.decathlon.in/p/8351755/x",
      rawHtml: decathlon,
      structuredBlocks,
      categoryRequiredAttributes: [],
    });
    expect(out.coverage.complete).toBe(true);
    expect(out.structured.facts.find((f) => f.rawKey === "title")).toBeDefined();
    expect(
      out.structured.facts.filter((f) =>
        /variants\[\d+\]\.option\.size/.test(f.rawKey)
      ).length
    ).toBe(10);
  });

  it("Bewakoof → full core coverage from NEXT_DATA, gaps for category-required attrs", async () => {
    const { structuredBlocks } = cleanHtml(bewakoof);
    const out = await extractStructured({
      pageUrl: "https://www.bewakoof.com.in/p/foo",
      rawHtml: bewakoof,
      structuredBlocks,
      categoryRequiredAttributes: ["material", "fit"],
    });
    expect(out.coverage.gaps).toEqual(["material", "fit"]);
  });

  it("Amazon captcha → halts with captchaSignal=true", async () => {
    const { structuredBlocks } = cleanHtml(captcha);
    const out = await extractStructured({
      pageUrl: "https://www.amazon.in/dp/X",
      rawHtml: captcha,
      structuredBlocks,
      categoryRequiredAttributes: [],
    });
    expect(out.captchaSignal).toBe(true);
    expect(out.structured.facts).toEqual([]);
  });
});
