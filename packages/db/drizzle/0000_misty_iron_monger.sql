CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'policy', 'worker', 'nango');--> statement-breakpoint
CREATE TYPE "public"."artifact_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'pending_failed', 'active', 'refresh_failing', 'revoked', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."dedup_kind" AS ENUM('new', 'merge', 'review', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_status" AS ENUM('pending', 'in_progress', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('direct', 'computed', 'inferred');--> statement-breakpoint
CREATE TYPE "public"."extraction_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'rate_limited');--> statement-breakpoint
CREATE TYPE "public"."marketplace" AS ENUM('shopify', 'amazon', 'ebay', 'walmart', 'etsy');--> statement-breakpoint
CREATE TYPE "public"."merchant_role" AS ENUM('admin', 'operator', 'reviewer', 'analyst', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'draft', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."proposed_diff_status" AS ENUM('pending', 'open', 'auto_approved', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."review_task_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."review_task_status" AS ENUM('open', 'in_progress', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TABLE "attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" varchar(200) NOT NULL,
	"data_type" varchar(32) NOT NULL,
	"unit_type" varchar(50),
	"canonical_unit" varchar(30),
	"allowed_units" text[] DEFAULT '{}' NOT NULL,
	"enum_values" text[] DEFAULT '{}' NOT NULL,
	"category_scope" text[] DEFAULT '{}' NOT NULL,
	"is_variant_option" boolean DEFAULT false NOT NULL,
	"validation_json" jsonb,
	"confidence_weight" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" varchar(200) NOT NULL,
	"model_version" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"marketplace" varchar(50) NOT NULL,
	"category_path" varchar(300) NOT NULL,
	"source_path" varchar(300) NOT NULL,
	"canonical_key" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_synonyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" varchar(200) NOT NULL,
	"synonym" varchar(200) NOT NULL,
	"source_marketplace" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid,
	"actor_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" varchar(200),
	"request_id" varchar(64),
	"trace_id" varchar(64),
	"payload_hash" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_schemas" (
	"category_path" varchar(300) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"json_schema" jsonb NOT NULL,
	"required_attributes" text[] DEFAULT '{}' NOT NULL,
	"optional_attributes" text[] DEFAULT '{}' NOT NULL,
	"variant_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"marketplace_mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" varchar(320) NOT NULL,
	"reason" text,
	"status" "deletion_request_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"sla_deadline" timestamp with time zone DEFAULT now() + INTERVAL '30 days' NOT NULL,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE "extracted_fact_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_run_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_set_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"raw_key" varchar(200) NOT NULL,
	"canonical_path" varchar(200),
	"extracted_value" jsonb NOT NULL,
	"normalized_value" jsonb,
	"unit" varchar(50),
	"source_pointer" varchar(500) NOT NULL,
	"extraction_method" "extraction_method" NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"mapping_method" varchar(50),
	"mapping_candidates" jsonb,
	"approved" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"extractor_version" varchar(100) NOT NULL,
	"mapper_version" varchar(100) NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"status" "extraction_run_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"job_type" varchar(32) NOT NULL,
	"status" "ingestion_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request_id" varchar(64),
	"trace_id" varchar(64),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mapping_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid,
	"source_key" varchar(200) NOT NULL,
	"canonical_key" varchar(200) NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"marketplace" "marketplace" NOT NULL,
	"provider" varchar(32) DEFAULT 'nango' NOT NULL,
	"provider_connection_id" varchar(200) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"connected_at" timestamp with time zone,
	"last_token_refresh_at" timestamp with time zone,
	"last_refresh_attempt" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_sessions" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" varchar(200) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"default_currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" varchar(32) NOT NULL,
	"auto_approve_threshold" numeric(4, 4) DEFAULT '0.9000' NOT NULL,
	"anomaly_threshold" numeric(4, 4) DEFAULT '0.5500' NOT NULL,
	"reject_threshold" numeric(4, 4) DEFAULT '0.5500' NOT NULL,
	"scoring_weights" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_webhooks" (
	"webhook_id" varchar(200) PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"identity_type" varchar(30) NOT NULL,
	"identity_value" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variant_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_version_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" varchar(200),
	"barcode" varchar(100),
	"price" numeric(12, 4),
	"currency" varchar(3),
	"inventory_quantity" numeric(12, 0),
	"variant_axes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"current_variant_version_id" uuid,
	"variant_key" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"proposed_diff_id" uuid NOT NULL,
	"title" varchar(500) NOT NULL,
	"brand" varchar(200),
	"gtin" varchar(30),
	"model_number" varchar(100),
	"base_price" numeric(12, 4),
	"currency" varchar(3),
	"images" jsonb,
	"description" text,
	"canonical_category" varchar(300),
	"confidence_score" numeric(5, 4) NOT NULL,
	"schema_version" varchar(20) DEFAULT '1' NOT NULL,
	"merchant_extensions_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"current_version_id" uuid,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"canonical_category" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposed_diff_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diff_id" uuid NOT NULL,
	"field_name" varchar(200) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"is_auto_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposed_diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source_fact_set_id" uuid NOT NULL,
	"product_id" uuid,
	"diff_type" varchar(20) NOT NULL,
	"status" "proposed_diff_status" DEFAULT 'pending' NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"confidence_score" numeric(5, 4) NOT NULL,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"diff_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"proposed_diff_id" uuid NOT NULL,
	"artifact_id" uuid,
	"task_type" varchar(50) NOT NULL,
	"severity" "review_task_severity" NOT NULL,
	"status" "review_task_status" DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"resolution_notes" text,
	"policy_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source_type" varchar(32) NOT NULL,
	"source_marketplace" "marketplace",
	"source_external_id" varchar(200) NOT NULL,
	"parent_artifact_id" uuid,
	"storage_uri" varchar(500),
	"raw_data" jsonb NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"status" "artifact_status" DEFAULT 'pending' NOT NULL,
	"processing_errors" jsonb,
	"sync_job_run_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"marketplace" "marketplace" NOT NULL,
	"webhook_id" varchar(200) NOT NULL,
	"sync_mode" varchar(20) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"records_added" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"error_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_fact_sets" ADD CONSTRAINT "extracted_fact_sets_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_facts" ADD CONSTRAINT "extracted_facts_fact_set_id_extracted_fact_sets_id_fk" FOREIGN KEY ("fact_set_id") REFERENCES "public"."extracted_fact_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_artifact_id_source_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD CONSTRAINT "mapping_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_overrides" ADD CONSTRAINT "mapping_overrides_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_connections" ADD CONSTRAINT "marketplace_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_connections" ADD CONSTRAINT "marketplace_connections_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_sessions" ADD CONSTRAINT "merchant_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identities" ADD CONSTRAINT "product_identities_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant_versions" ADD CONSTRAINT "product_variant_versions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant_versions" ADD CONSTRAINT "product_variant_versions_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_proposed_diff_id_proposed_diffs_id_fk" FOREIGN KEY ("proposed_diff_id") REFERENCES "public"."proposed_diffs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_diff_fields" ADD CONSTRAINT "proposed_diff_fields_diff_id_proposed_diffs_id_fk" FOREIGN KEY ("diff_id") REFERENCES "public"."proposed_diffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_diffs" ADD CONSTRAINT "proposed_diffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_diffs" ADD CONSTRAINT "proposed_diffs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_diffs" ADD CONSTRAINT "proposed_diffs_source_fact_set_id_extracted_fact_sets_id_fk" FOREIGN KEY ("source_fact_set_id") REFERENCES "public"."extracted_fact_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_diffs" ADD CONSTRAINT "proposed_diffs_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_proposed_diff_id_proposed_diffs_id_fk" FOREIGN KEY ("proposed_diff_id") REFERENCES "public"."proposed_diffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job_runs" ADD CONSTRAINT "sync_job_runs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attribute_definitions_key" ON "attribute_definitions" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "idx_attribute_embeddings_key" ON "attribute_embeddings" USING btree ("canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attribute_mappings_lookup" ON "attribute_mappings" USING btree ("marketplace","category_path","source_path");--> statement-breakpoint
CREATE INDEX "idx_attribute_synonyms_synonym" ON "attribute_synonyms" USING btree ("synonym");--> statement-breakpoint
CREATE INDEX "idx_attribute_synonyms_canonical" ON "attribute_synonyms" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "idx_audit_merchant_created" ON "audit_events" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_event_type" ON "audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_category_schemas_path_version" ON "category_schemas" USING btree ("category_path","schema_version");--> statement-breakpoint
CREATE INDEX "idx_deletion_requests_merchant" ON "deletion_requests" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "idx_deletion_requests_status" ON "deletion_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_extracted_fact_sets_run" ON "extracted_fact_sets" USING btree ("extraction_run_id");--> statement-breakpoint
CREATE INDEX "idx_extracted_facts_fact_set" ON "extracted_facts" USING btree ("fact_set_id");--> statement-breakpoint
CREATE INDEX "idx_extracted_facts_canonical" ON "extracted_facts" USING btree ("canonical_path");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_extraction_runs_idempotency" ON "extraction_runs" USING btree ("artifact_id","extractor_version","mapper_version","policy_version_id");--> statement-breakpoint
CREATE INDEX "idx_extraction_runs_artifact" ON "extraction_runs" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_ingestion_jobs_merchant" ON "ingestion_jobs" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ingestion_jobs_status" ON "ingestion_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_mapping_overrides_tenant" ON "mapping_overrides" USING btree ("tenant_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_merchant_marketplace" ON "marketplace_connections" USING btree ("merchant_id","marketplace");--> statement-breakpoint
CREATE INDEX "idx_connections_tenant" ON "marketplace_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_connections_status" ON "marketplace_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sessions_merchant" ON "merchant_sessions" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "merchant_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_merchants_tenant" ON "merchants" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_policy_version" ON "policy_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "idx_processed_webhooks_received_at" ON "processed_webhooks" USING brin ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_identities" ON "product_identities" USING btree ("tenant_id","identity_type","identity_value");--> statement-breakpoint
CREATE INDEX "idx_product_variant_versions_variant" ON "product_variant_versions" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "idx_product_variant_versions_pv" ON "product_variant_versions" USING btree ("product_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_variants_key" ON "product_variants" USING btree ("product_id","variant_key");--> statement-breakpoint
CREATE INDEX "idx_product_versions_product" ON "product_versions" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_product_versions_diff" ON "product_versions" USING btree ("proposed_diff_id");--> statement-breakpoint
CREATE INDEX "idx_product_versions_created" ON "product_versions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_products_tenant" ON "products" USING btree ("tenant_id","merchant_id");--> statement-breakpoint
CREATE INDEX "idx_products_status" ON "products" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_proposed_diff_fields_diff" ON "proposed_diff_fields" USING btree ("diff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposed_diffs_idempotency" ON "proposed_diffs" USING btree ("source_fact_set_id","diff_type");--> statement-breakpoint
CREATE INDEX "idx_proposed_diffs_status" ON "proposed_diffs" USING btree ("status","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_proposed_diffs_product" ON "proposed_diffs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_review_tasks_tenant_status" ON "review_tasks" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_review_tasks_diff" ON "review_tasks" USING btree ("proposed_diff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_artifacts_dedup" ON "source_artifacts" USING btree ("merchant_id","source_marketplace","source_external_id","checksum");--> statement-breakpoint
CREATE INDEX "idx_source_artifacts_merchant_status" ON "source_artifacts" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "idx_source_artifacts_modified" ON "source_artifacts" USING btree ("source_marketplace","modified_at");--> statement-breakpoint
CREATE INDEX "idx_sync_runs_webhook" ON "sync_job_runs" USING btree ("webhook_id");
