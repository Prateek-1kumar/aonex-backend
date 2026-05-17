export { extractPriceFromDom } from "./price.js";
export { extractTitleFromDom } from "./title.js";
export { extractDescriptionFromDom } from "./description.js";
export { extractImagesFromDom } from "./images.js";
export { extractBreadcrumbFromDom } from "./breadcrumb.js";
export { extractSpecTableFromDom } from "./spec-table.js";
export { extractVariantSelectorFromDom } from "./variant-selector.js";

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import { extractPriceFromDom } from "./price.js";
import { extractTitleFromDom } from "./title.js";
import { extractDescriptionFromDom } from "./description.js";
import { extractImagesFromDom } from "./images.js";
import { extractBreadcrumbFromDom } from "./breadcrumb.js";
import { extractSpecTableFromDom } from "./spec-table.js";
import { extractVariantSelectorFromDom } from "./variant-selector.js";

export interface DomHeuristicResult {
  facts: ExtractedFact[];
}

export function runDomHeuristics(rawHtml: string): DomHeuristicResult {
  const facts: ExtractedFact[] = [];
  const price = extractPriceFromDom(rawHtml);
  if (price) facts.push(price);
  facts.push(...extractImagesFromDom(rawHtml));
  const breadcrumb = extractBreadcrumbFromDom(rawHtml);
  if (breadcrumb) facts.push(breadcrumb);
  facts.push(...extractSpecTableFromDom(rawHtml));
  facts.push(...extractVariantSelectorFromDom(rawHtml));
  const title = extractTitleFromDom(rawHtml);
  if (title) facts.push(title);
  const desc = extractDescriptionFromDom(rawHtml);
  if (desc) facts.push(desc);
  return { facts };
}
