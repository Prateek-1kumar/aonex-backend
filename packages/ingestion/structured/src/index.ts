import { parseJsonLd } from "./parsers/json-ld.js";
import { parseShopifyProbe } from "./parsers/shopify-probe.js";
import { parseNextData } from "./parsers/next-data.js";
import { parseMicrodata } from "./parsers/microdata.js";
import { parseOpenGraph } from "./parsers/opengraph.js";
import { mergeParserOutputs } from "./merge.js";
import { checkCoverage, type CoverageResult } from "./coverage.js";
import { isCaptchaWall } from "./captcha-detect.js";
import { inferCurrency } from "./currency-inference.js";
import type { StructuredBlocks } from "@aonex/ingestion-link-fetcher";
import type { StructuredResult } from "./types.js";

export interface ExtractStructuredInput {
  pageUrl: string;
  rawHtml: string;
  structuredBlocks: StructuredBlocks;
  categoryRequiredAttributes?: string[];
}

export interface ExtractStructuredOutput {
  structured: StructuredResult;
  coverage: CoverageResult;
  captchaSignal: boolean;
}

export async function extractStructured(
  input: ExtractStructuredInput
): Promise<ExtractStructuredOutput> {
  const captchaSignal = isCaptchaWall(input.rawHtml);
  if (captchaSignal) {
    return {
      structured: {
        facts: [],
        byParser: {
          json_ld: null,
          shopify_probe: null,
          next_data: null,
          microdata: null,
          opengraph: null,
          nuxt: null,
          initial_state: null,
          magento: null,
          woocommerce: null,
          algolia: null,
        },
        category: { path: null, confidence: 0 },
      },
      coverage: { complete: false, gaps: ["captcha_wall"] },
      captchaSignal,
    };
  }

  const [shopify] = await Promise.all([
    parseShopifyProbe(input.pageUrl),
  ]);

  const outputs = [
    parseJsonLd(input.structuredBlocks.jsonLd, { pageUrl: input.pageUrl }),
    shopify,
    parseNextData(input.structuredBlocks.nextData),
    parseMicrodata(input.rawHtml),
    parseOpenGraph(input.rawHtml),
  ];

  const structured = mergeParserOutputs(outputs);

  const inferredCurrency = inferCurrency(input.pageUrl, structured.facts);
  if (inferredCurrency) {
    structured.facts.push(inferredCurrency);
  }

  const coverage = checkCoverage(
    structured.facts,
    input.categoryRequiredAttributes ?? []
  );

  return { structured, coverage, captchaSignal };
}

export * from "./types.js";
export { checkCoverage } from "./coverage.js";
export { isCaptchaWall } from "./captcha-detect.js";
