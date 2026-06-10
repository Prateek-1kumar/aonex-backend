// Taxonomy classifier — deterministic layers (alias exact-match + lexical
// token-overlap) with calibrated abstain. The LLM/embedding fallback (P1.2)
// slots in below the abstain line.

import type {
  Candidate,
  ClassifierIndex,
  ClassifyOptions,
  ClassifyResult,
  LeafEntry,
  ProductSignals,
} from "./types.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "set", "pack", "new", "pro", "plus", "max", "mini",
  "kit", "size", "color", "colour", "inch", "men", "women", "kids", "unisex",
]);

export const normLabel = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const singular = (t: string) => (t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

/** Tokenize to singularized, stopword-free, length>=3 content tokens. */
export function tokenize(s: string): string[] {
  return normLabel(s)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(singular);
}

const titleCaseSlug = (s: string) => s.split("-").map((w) => (w[0] ?? "").toUpperCase() + w.slice(1)).join(" ");

/** Build a classifier index from leaf {nodeId, displayName} + the alias map.
 *  `departments` (id+display name) may be supplied; else derived from slugs. */
export function buildIndex(
  leaves: { nodeId: string; displayName: string }[],
  aliases: Map<string, string>,
  departments?: { id: string; name: string }[]
): ClassifierIndex {
  const deptIds = [...new Set(leaves.map((l) => l.nodeId.split("/")[0] ?? ""))].filter(Boolean);
  return {
    aliases,
    leaves: leaves.map((l): LeafEntry => ({
      nodeId: l.nodeId,
      displayName: l.displayName,
      departmentId: l.nodeId.split("/")[0] ?? "",
      nameTokens: tokenize(l.displayName),
    })),
    departments: departments ?? deptIds.map((id) => ({ id, name: titleCaseSlug(id) })),
  };
}

function catVariants(sc: string): string[] {
  if (!sc) return [];
  const last = sc.split(/[>/|]/).pop() ?? sc;
  const b = normLabel(sc);
  return [...new Set([b, b.replace(/ /g, ""), normLabel(last), normLabel(last).replace(/ /g, "")])].filter(Boolean);
}

function aliasLayer(signals: ProductSignals, index: ClassifierIndex): { nodeId: string; confidence: number } | null {
  for (const cand of catVariants(signals.sourceCategory ?? "")) {
    const hit = index.aliases.get(cand);
    if (hit) return { nodeId: hit, confidence: 0.92 };
  }
  // Exclude brand tokens — a brand like "Ring" must not match the "Rings" alias.
  const brandToks = new Set(normLabel(signals.brand ?? "").split(" ").filter(Boolean));
  const toks = normLabel(signals.title ?? "").split(" ").filter((t) => t && !brandToks.has(t));
  let best: string | null = null;
  let bestLevel = -1;
  for (let i = 0; i < toks.length; i++) {
    for (const cand of [toks[i]!, toks.slice(i, i + 2).join(" "), toks.slice(i, i + 2).join("")]) {
      const hit = index.aliases.get(cand);
      if (hit) {
        const lv = hit.split("/").length;
        if (lv > bestLevel) { best = hit; bestLevel = lv; }
      }
    }
  }
  return best ? { nodeId: best, confidence: 0.8 } : null;
}

/** Resolve product signals to a canonical leaf, or abstain (nodeId=null). */
export function classify(signals: ProductSignals, index: ClassifierIndex, opts: ClassifyOptions = {}): ClassifyResult {
  const threshold = opts.lexicalThreshold ?? 0.5;
  const topN = opts.topN ?? 3;

  const alias = aliasLayer(signals, index);
  if (alias) return { nodeId: alias.nodeId, confidence: alias.confidence, method: "alias", alternatives: [{ nodeId: alias.nodeId, score: alias.confidence }] };

  // Lexical: fraction of a leaf's name tokens present in title+sourceCategory,
  // minus brand tokens. Full-name matches win.
  const brandTokens = new Set(tokenize(signals.brand ?? ""));
  const query = new Set(
    [...tokenize(signals.title ?? ""), ...tokenize(signals.sourceCategory ?? "")].filter((t) => !brandTokens.has(t))
  );
  const scored: Candidate[] = index.leaves.map((leaf) => {
    const nt = leaf.nameTokens;
    if (nt.length === 0) return { nodeId: leaf.nodeId, score: 0 };
    // The leaf's HEAD noun (last token) must appear — stops "electric" matching
    // "Electric Kettles" or "video" matching "Video Games" on a stray token.
    if (!query.has(nt[nt.length - 1]!)) return { nodeId: leaf.nodeId, score: 0 };
    const matched = nt.filter((t) => query.has(t)).length;
    return { nodeId: leaf.nodeId, score: matched / nt.length };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN);
  const best = top[0];

  if (!best || best.score < threshold) {
    return { nodeId: null, confidence: best?.score ?? 0, method: "abstain", alternatives: top.filter((c) => c.score > 0) };
  }
  return { nodeId: best.nodeId, confidence: best.score, method: "lexical", alternatives: top };
}
