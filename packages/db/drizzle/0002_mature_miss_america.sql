CREATE TYPE "public"."extraction_failure_reason" AS ENUM('fetch_blocked', 'captcha_wall', 'no_product_found', 'parse_failed', 'llm_extraction_failed', 'wrong_value', 'missing_field', 'wrong_category');--> statement-breakpoint
ALTER TYPE "public"."extraction_method" ADD VALUE 'override';--> statement-breakpoint
CREATE TABLE "domain_profiles" (
	"domain_pattern" varchar(200) PRIMARY KEY NOT NULL,
	"preferred_parsers" jsonb,
	"llm_hit_rate" numeric(5, 4),
	"avg_confidence" numeric(5, 4),
	"sample_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain_pattern" varchar(200) NOT NULL,
	"raw_key" varchar(200),
	"source_pointer" text,
	"reason" "extraction_failure_reason" NOT NULL,
	"reviewer_note" text,
	"review_task_id" uuid,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand" varchar(200) NOT NULL,
	"canonical_category" varchar(300) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"median_price" numeric(12, 4) NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_mapping_overrides_tenant";--> statement-breakpoint
ALTER TABLE "attribute_synonyms" ADD COLUMN "source" varchar(20);--> statement-breakpoint
ALTER TABLE "attribute_synonyms" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attribute_synonyms" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "domain_pattern" varchar(200);--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "normalization_rule" jsonb;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "usage_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "promote_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD COLUMN "source_review_task_id" uuid;--> statement-breakpoint
ALTER TABLE "marketplace_connections" ADD COLUMN "encrypted_access_token" text;--> statement-breakpoint
ALTER TABLE "marketplace_connections" ADD COLUMN "shop_domain" varchar(200);--> statement-breakpoint
ALTER TABLE "review_tasks" ADD COLUMN "signal_kind" varchar(50);--> statement-breakpoint
ALTER TABLE "review_tasks" ADD COLUMN "signal_payload" jsonb;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD COLUMN "cluster_key" varchar(64);--> statement-breakpoint
ALTER TABLE "review_tasks" ADD COLUMN "field_name" varchar(100);--> statement-breakpoint
ALTER TABLE "extraction_failures" ADD CONSTRAINT "extraction_failures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_failures" ADD CONSTRAINT "extraction_failures_review_task_id_review_tasks_id_fk" FOREIGN KEY ("review_task_id") REFERENCES "public"."review_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_extraction_failures_domain_reason" ON "extraction_failures" USING btree ("domain_pattern","reason");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_price_clusters" ON "price_clusters" USING btree ("tenant_id","brand","canonical_category","currency");--> statement-breakpoint
CREATE INDEX "idx_mapping_overrides_tenant_source" ON "mapping_overrides" USING btree ("tenant_id","source_key");--> statement-breakpoint
CREATE INDEX "idx_mapping_overrides_scope" ON "mapping_overrides" USING btree ("tenant_id","domain_pattern","source_key");--> statement-breakpoint
CREATE INDEX "idx_review_tasks_cluster" ON "review_tasks" USING btree ("tenant_id","cluster_key","status");