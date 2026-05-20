-- Recreate the channels unique constraint with NULLS NOT DISTINCT so that
-- two rows with the same (tenant_id, channel_kind, NULL, NULL) are correctly
-- rejected. Standard B-tree unique indexes treat NULLs as distinct, which
-- allows duplicate "null region / null account_ref" rows for the same tenant+kind.
-- Requires Postgres 15+.

DROP INDEX IF EXISTS "uq_channels";
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "uq_channels"
  UNIQUE NULLS NOT DISTINCT ("tenant_id", "channel_kind", "region", "account_ref");
