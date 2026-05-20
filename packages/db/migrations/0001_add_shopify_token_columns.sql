ALTER TABLE "marketplace_connections" ADD COLUMN "encrypted_access_token" text;--> statement-breakpoint
ALTER TABLE "marketplace_connections" ADD COLUMN "shop_domain" varchar(200);
