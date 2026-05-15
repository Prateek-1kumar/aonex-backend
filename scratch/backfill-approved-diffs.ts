// One-off backfill: materialize product_versions for proposed_diffs that are
// status='approved' (or 'auto_approved') but lack a corresponding product_version
// row. This happens for diffs approved before the editAndApprove → applyApprovedDiff
// wiring landed.
//
// Run: bun run scratch/backfill-approved-diffs.ts

import { createDb } from "@aonex/db";
import { applyApprovedDiff } from "@aonex/catalog-service";
import { sql } from "drizzle-orm";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const { client, pool } = createDb(databaseUrl);

const orphans = await client.execute<{ id: string }>(sql`
  SELECT pd.id::text AS id
  FROM proposed_diffs pd
  LEFT JOIN product_versions pv ON pv.proposed_diff_id = pd.id
  WHERE pd.status IN ('approved','auto_approved')
    AND pv.id IS NULL
  ORDER BY pd.created_at ASC
`);

const rows = (orphans as unknown as { rows?: { id: string }[] }).rows
  ?? (orphans as unknown as { id: string }[]);
const list = Array.isArray(rows) ? rows : [];

console.log(`Found ${list.length} orphan(s)`);
for (const row of list) {
  try {
    const result = await applyApprovedDiff({
      db: client,
      diffId: row.id,
      actorId: null,
      approvalStatus: "approved",
    });
    console.log(`  ✓ ${row.id} → product=${result.productId} version=${result.productVersionId} createdVersion=${result.createdVersion}`);
  } catch (err) {
    console.error(`  ✗ ${row.id}: ${(err as Error).message}`);
  }
}

await pool.end();
console.log("done");
