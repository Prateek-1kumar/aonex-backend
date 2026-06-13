#!/usr/bin/env bun
/**
 * validate-golden.ts — mechanical conformance check for the golden set.
 *
 * The golden set is the ANSWER KEY: every gold.node_id must be a real taxonomy
 * leaf, and every gold.attrs value must conform to that leaf's attribute schema
 * (known key, allowed enum value, allowed unit). This catches the entire
 * *conformance* class of mistakes so human review only has to judge *truthfulness*
 * (is the iPhone actually 128GB?), not whether a label is structurally valid.
 *
 * Validates against the LIVE DB schema (loadLeafSchemas) — the same schema the
 * eval scores against — so a passing answer key can never be rejected by the eval.
 *
 *   set -a; . ./.env; set +a
 *   bun scripts/eval/validate-golden.ts        # exits non-zero on any violation
 */
import { createDb } from "@aonex/db";
import { loadLeafSchemas, leafSchemaFor } from "@aonex/taxonomy-schema";
import { validateAttributes } from "@aonex/taxonomy-validator";
import { loadGoldenProducts } from "./load-golden-yaml.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";
const ABSTAIN = "ABSTAIN";

const { client: db, close } = createDb(databaseUrl);
try {
  const idx = await loadLeafSchemas(db);
  const golden = loadGoldenProducts();

  const problems: string[] = [];
  let inTaxonomy = 0;
  let abstain = 0;
  let withAttrs = 0;

  for (const p of golden) {
    if (p.gold.node_id === ABSTAIN) {
      abstain++;
      if (p.gold.attrs && Object.keys(p.gold.attrs).length > 0) {
        problems.push(`${p.id}: ABSTAIN entry should not carry gold.attrs`);
      }
      continue;
    }

    const leaf = leafSchemaFor(idx, p.gold.node_id);
    if (!leaf) {
      problems.push(`${p.id}: gold.node_id "${p.gold.node_id}" is not a known leaf with a schema`);
      continue;
    }
    inTaxonomy++;

    const attrs = p.gold.attrs ?? {};
    const keys = Object.keys(attrs);
    if (keys.length === 0) continue;
    withAttrs++;

    const known = new Set(leaf.attributes.map((a) => a.key));
    for (const k of keys) {
      if (!known.has(k)) {
        problems.push(
          `${p.id}: gold.attrs key "${k}" is not in the schema for ${p.gold.node_id} (allowed: ${[...known].join(", ") || "none"})`
        );
      }
    }

    // Run the SAME validator the eval uses: invalid = bad enum/unit/type.
    const r = validateAttributes(leaf, attrs);
    for (const f of r.fields) {
      if (f.status === "invalid") {
        problems.push(
          `${p.id}: gold.attrs.${f.key} = ${JSON.stringify(attrs[f.key])} is invalid for ${p.gold.node_id}${f.message ? ` (${f.message})` : ""}`
        );
      }
    }
  }

  /* eslint-disable no-console */
  console.log(`\n===== GOLDEN VALIDATION =====`);
  console.log(`entries:        ${golden.length}  (${inTaxonomy} in-taxonomy, ${abstain} ABSTAIN)`);
  console.log(`with gold.attrs: ${withAttrs}/${inTaxonomy} in-taxonomy entries carry expected attribute values`);
  if (problems.length === 0) {
    console.log(`✓ all gold.node_id + gold.attrs conform to the live leaf schemas`);
  } else {
    console.error(`\n✖ ${problems.length} conformance problem(s):`);
    for (const pr of problems) console.error(`  - ${pr}`);
    process.exitCode = 1;
  }
  console.log(`=============================\n`);
  /* eslint-enable no-console */
} finally {
  await close();
}
