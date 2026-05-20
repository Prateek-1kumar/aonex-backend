CREATE TABLE "catalog_products" (
	"product_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"parent_product_id" uuid,
	"primary_identifier" text NOT NULL,
	"identity" jsonb NOT NULL,
	"family" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"merged_into_product_id" uuid,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"winning_values" jsonb,
	"winning_values_shadow" jsonb,
	"current_revision_id" bigint,
	"schema_version" text DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_catalog_products_tenant_identifier" UNIQUE("tenant_id","primary_identifier")
);
--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_parent_product_id_catalog_products_product_id_fk" FOREIGN KEY ("parent_product_id") REFERENCES "public"."catalog_products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_merged_into_product_id_catalog_products_product_id_fk" FOREIGN KEY ("merged_into_product_id") REFERENCES "public"."catalog_products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_catalog_products_parent" ON "catalog_products" USING btree ("parent_product_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_products_tenant_status" ON "catalog_products" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_catalog_products_family" ON "catalog_products" USING btree ("family");
