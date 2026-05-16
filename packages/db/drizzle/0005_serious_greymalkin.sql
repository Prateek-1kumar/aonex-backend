CREATE TABLE "category_attribute_promotion_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_path" varchar(300) NOT NULL,
	"attribute_key" varchar(200) NOT NULL,
	"products_with_key" integer DEFAULT 0 NOT NULL,
	"total_products" integer DEFAULT 0 NOT NULL,
	"consistency_ratio" numeric(5, 4) DEFAULT '0' NOT NULL,
	"status" varchar(20) DEFAULT 'candidate' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_labels" (
	"category_path" varchar(300) NOT NULL,
	"locale" varchar(10) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_category_overlays" (
	"tenant_id" uuid NOT NULL,
	"category_path" varchar(300) NOT NULL,
	"schema_version" varchar(50) NOT NULL,
	"overlay_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "category_schemas" ADD COLUMN "tier" varchar(20) DEFAULT 'authoritative' NOT NULL;--> statement-breakpoint
ALTER TABLE "category_schemas" ADD COLUMN "parent_path" varchar(300);--> statement-breakpoint
ALTER TABLE "category_schemas" ADD COLUMN "display_name" varchar(200) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "category_schemas" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "gtin_type" varchar(10);--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "manufacturer_part_number" varchar(100);--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "weight_grams" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "dimensions_cm" jsonb;--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "category_schema_version" varchar(50);--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "category_confidence" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "attributes_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "evidence_summary" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_category_overlays" ADD CONSTRAINT "tenant_category_overlays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_promotion_candidates" ON "category_attribute_promotion_candidates" USING btree ("category_path","attribute_key");--> statement-breakpoint
CREATE INDEX "idx_promotion_candidates_status" ON "category_attribute_promotion_candidates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_category_labels" ON "category_labels" USING btree ("category_path","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenant_category_overlays" ON "tenant_category_overlays" USING btree ("tenant_id","category_path","schema_version");--> statement-breakpoint
CREATE INDEX "idx_product_versions_attrs_gin" ON "product_versions" USING gin ("attributes_json");--> statement-breakpoint
CREATE INDEX "idx_product_versions_category" ON "product_versions" USING btree ("canonical_category");