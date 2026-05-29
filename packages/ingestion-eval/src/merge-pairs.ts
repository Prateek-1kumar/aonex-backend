// Phase 2 Task 14: labeled identity-pair eval surface (spec D5 / acceptance).
// Computes mergePrecision: of pairs the system auto-merges, the fraction that
// the labels say SHOULD merge. A wrong auto-merge tanks mergePrecision; a
// missed merge does not (those go to the Lab — which is the right place for
// uncertain cases per D2).

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface IdentityPair {
  id: string;
  label: "same" | "different";
  a: { identifiers: Array<{ type: string; value: string; source: string; corroborated?: boolean }>; variant: Record<string, string> };
  b: { identifiers: Array<{ type: string; value: string; source: string; corroborated?: boolean }>; variant: Record<string, string> };
}

export interface MergeMetrics {
  total: number;
  autoMerged: number;        // pairs the system auto-merged
  wrongAutoMerges: number;   // pairs the system auto-merged that should NOT have merged
  mergePrecision: number;    // (autoMerged - wrongAutoMerges) / autoMerged; 1.0 when no auto-merges
}

/** Decide what the resolution would be for one pair. Mirrors decideResolution
 *  from @aonex/catalog-service but without importing it (avoids a workspace
 *  cycle): auto-merge ONLY when a/b share at least one strong-by-source key
 *  AND no variant axis differs.
 *
 *  This is intentionally a re-statement of the rule rather than an import, so
 *  the eval can verify the rule's behavior independently of catalog-service's
 *  internal wiring (catches drift between the spec and the impl). */
export function wouldAutoMerge(a: IdentityPair["a"], b: IdentityPair["b"]): boolean {
  const aStrong = new Set(
    a.identifiers
      .filter((i) => !(i.source.startsWith("backfill") && !i.corroborated))
      .filter((i) => i.type === "gtin" || i.type === "upc" || i.type === "mpn")
      .map((i) => `${i.type}:${i.value}`)
  );
  const sharesStrongKey = b.identifiers.some(
    (i) =>
      !(i.source.startsWith("backfill") && !i.corroborated) &&
      (i.type === "gtin" || i.type === "upc" || i.type === "mpn") &&
      aStrong.has(`${i.type}:${i.value}`)
  );
  if (!sharesStrongKey) return false;
  // Variant conflict check (mirrors variant-guard.ts)
  for (const axis of ["storage", "size", "color", "ram", "region"] as const) {
    const av = a.variant[axis]?.toLowerCase().trim();
    const bv = b.variant[axis]?.toLowerCase().trim();
    if (av && bv && av !== bv) return false;
  }
  return true;
}

export async function loadIdentityPairs(dir: string): Promise<{ pairs: IdentityPair[]; errors: string[] }> {
  const pairs: IdentityPair[] = [];
  const errors: string[] = [];
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(await Bun.file(join(dir, name)).text()) as IdentityPair;
      if (!obj.id || (obj.label !== "same" && obj.label !== "different")) {
        errors.push(`${name}: missing id or invalid label`);
        continue;
      }
      pairs.push(obj);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { pairs, errors };
}

export function mergeMetrics(pairs: IdentityPair[]): MergeMetrics {
  let autoMerged = 0;
  let wrongAutoMerges = 0;
  for (const p of pairs) {
    if (wouldAutoMerge(p.a, p.b)) {
      autoMerged++;
      if (p.label !== "same") wrongAutoMerges++;
    }
  }
  const correctAuto = autoMerged - wrongAutoMerges;
  const mergePrecision = autoMerged === 0 ? 1 : correctAuto / autoMerged;
  return { total: pairs.length, autoMerged, wrongAutoMerges, mergePrecision };
}
