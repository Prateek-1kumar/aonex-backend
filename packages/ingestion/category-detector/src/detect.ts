// HLD §9 — rule-based category detection.
// Phase 1: scan productType and title against known category paths.
// AI fallback (HLD §28 open question — Haiku-class) is DEFERRED — see stub below.
// Confidence < 0.70 → caller must route to Anomaly Lab or reject (never auto-approve).

import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import type { DetectionResult } from "./types.js";

export const DETECTOR_VERSION = "rule-based@1.0.0";

// Threshold per HLD §9: below this → AI fallback territory (stubbed)
const CONFIDENCE_THRESHOLD = 0.70;

/**
 * Pure function — no DB access. Receives the fact set and the list of known
 * category paths (passed in from the worker which reads category_schemas).
 *
 * Algorithm:
 * 1. Exact productType match against category path leaf (confidence 0.85)
 * 2. Substring productType match against any path segment (confidence 0.75)
 * 3. Title keyword match against path segments (confidence 0.65)
 * 4. Fallback: null, confidence 0.0
 */
export function detect(
  factSet: ExtractedFactSet,
  knownCategoryPaths: string[]
): DetectionResult {
  const productTypeFact = factSet.facts.find((f) => f.rawKey === "productType");
  const titleFact = factSet.facts.find((f) => f.rawKey === "title");
  const tagsFact = factSet.facts.find((f) => f.rawKey === "tags");

  const productType = normalizeText(String(productTypeFact?.extractedValue ?? ""));
  const title = normalizeText(String(titleFact?.extractedValue ?? ""));
  const tags = Array.isArray(tagsFact?.extractedValue)
    ? (tagsFact.extractedValue as unknown[]).map((t) => normalizeText(String(t)))
    : [];

  // 1. Exact match: productType exactly equals the leaf segment of a category path
  if (productType) {
    for (const path of knownCategoryPaths) {
      const leaf = path.split("/").pop()!.toLowerCase().trim();
      if (leaf === productType) {
        return { categoryPath: path, confidence: 0.85, evidence: `productType exact match: "${productType}"` };
      }
    }
  }

  // 2. Substring match: productType contained in any path segment
  if (productType) {
    for (const path of knownCategoryPaths) {
      const segments = path.split("/").map((s) => s.toLowerCase().trim());
      const hit = segments.find((seg) => seg.includes(productType) || productType.includes(seg));
      if (hit) {
        return { categoryPath: path, confidence: 0.75, evidence: `productType substring match: "${productType}" ↔ "${hit}"` };
      }
    }
  }

  // 3. Title keyword match: any path segment appears as a whole word in the title
  if (title) {
    for (const path of knownCategoryPaths) {
      const segments = path.split("/").map((s) => s.toLowerCase().trim());
      for (const seg of segments) {
        if (seg.length >= 4 && titleContainsWord(title, seg)) {
          return { categoryPath: path, confidence: 0.65, evidence: `title keyword match: "${seg}"` };
        }
      }
    }
  }

  // 4. Tag keyword match (lower confidence — tags are noisy)
  for (const tag of tags) {
    for (const path of knownCategoryPaths) {
      const segments = path.split("/").map((s) => s.toLowerCase().trim());
      if (segments.some((seg) => seg === tag)) {
        return { categoryPath: path, confidence: 0.60, evidence: `tag exact match: "${tag}"` };
      }
    }
  }

  // No rule matched.
  // TODO: AI fallback (HLD §28 open question — Haiku-class model behind model-router).
  // When confidence < CONFIDENCE_THRESHOLD, the worker will route to Anomaly Lab.
  return { categoryPath: null, confidence: 0.0, evidence: "no rule matched" };
}

function normalizeText(s: string): string {
  return s.toLowerCase().trim().replace(/[-_]/g, " ");
}

function titleContainsWord(title: string, word: string): boolean {
  // Whole-word check: word must appear surrounded by non-alphanumeric chars or at boundaries
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(title);
}

export { CONFIDENCE_THRESHOLD };
