// Branded identifier types — kill primitive obsession at compile time.
// Engineering principles doc §"No primitive obsession". Construction
// goes through `.parse()`; `unsafeFrom()` is audit-logged when needed.

import { z } from "zod";

const uuidSchema = z.string().uuid();

// ---------- TenantId ----------------------------------------------------
declare const tenantIdBrand: unique symbol;
export type TenantId = string & { readonly [tenantIdBrand]: true };

export const TenantId = {
  parse(input: unknown): TenantId {
    return uuidSchema.parse(input) as TenantId;
  },
  unsafeFrom(value: string): TenantId {
    return value as TenantId;
  }
};

// ---------- MerchantId --------------------------------------------------
declare const merchantIdBrand: unique symbol;
export type MerchantId = string & { readonly [merchantIdBrand]: true };

export const MerchantId = {
  parse(input: unknown): MerchantId {
    return uuidSchema.parse(input) as MerchantId;
  },
  unsafeFrom(value: string): MerchantId {
    return value as MerchantId;
  }
};

// ---------- ConnectionId -----------------------------------------------
// Nango's connection_id is a string the gateway hands back. Branded so
// we cannot accidentally pass a MerchantId where a ConnectionId is needed.
declare const connectionIdBrand: unique symbol;
export type ConnectionId = string & { readonly [connectionIdBrand]: true };

export const ConnectionId = {
  parse(input: unknown): ConnectionId {
    return z.string().min(1).parse(input) as ConnectionId;
  },
  unsafeFrom(value: string): ConnectionId {
    return value as ConnectionId;
  }
};

// ---------- ArtifactId -------------------------------------------------
declare const artifactIdBrand: unique symbol;
export type ArtifactId = string & { readonly [artifactIdBrand]: true };

export const ArtifactId = {
  parse(input: unknown): ArtifactId {
    return uuidSchema.parse(input) as ArtifactId;
  },
  unsafeFrom(value: string): ArtifactId {
    return value as ArtifactId;
  }
};

// ---------- WebhookId --------------------------------------------------
// SHA-256 hex of raw body. 64 chars.
declare const webhookIdBrand: unique symbol;
export type WebhookId = string & { readonly [webhookIdBrand]: true };

export const WebhookId = {
  parse(input: unknown): WebhookId {
    return z
      .string()
      .regex(/^[a-f0-9]{64}$/, "WebhookId must be 64-char hex")
      .parse(input) as WebhookId;
  },
  unsafeFrom(value: string): WebhookId {
    return value as WebhookId;
  }
};

// ---------- Phase 2 IDs ------------------------------------------------

declare const productIdBrand: unique symbol;
export type ProductId = string & { readonly [productIdBrand]: true };
export const ProductId = {
  parse(input: unknown): ProductId { return uuidSchema.parse(input) as ProductId; },
  unsafeFrom(value: string): ProductId { return value as ProductId; }
};

declare const productVersionIdBrand: unique symbol;
export type ProductVersionId = string & { readonly [productVersionIdBrand]: true };
export const ProductVersionId = {
  parse(input: unknown): ProductVersionId { return uuidSchema.parse(input) as ProductVersionId; },
  unsafeFrom(value: string): ProductVersionId { return value as ProductVersionId; }
};

declare const productVariantIdBrand: unique symbol;
export type ProductVariantId = string & { readonly [productVariantIdBrand]: true };
export const ProductVariantId = {
  parse(input: unknown): ProductVariantId { return uuidSchema.parse(input) as ProductVariantId; },
  unsafeFrom(value: string): ProductVariantId { return value as ProductVariantId; }
};

declare const proposedDiffIdBrand: unique symbol;
export type ProposedDiffId = string & { readonly [proposedDiffIdBrand]: true };
export const ProposedDiffId = {
  parse(input: unknown): ProposedDiffId { return uuidSchema.parse(input) as ProposedDiffId; },
  unsafeFrom(value: string): ProposedDiffId { return value as ProposedDiffId; }
};

declare const extractionRunIdBrand: unique symbol;
export type ExtractionRunId = string & { readonly [extractionRunIdBrand]: true };
export const ExtractionRunId = {
  parse(input: unknown): ExtractionRunId { return uuidSchema.parse(input) as ExtractionRunId; },
  unsafeFrom(value: string): ExtractionRunId { return value as ExtractionRunId; }
};

declare const factSetIdBrand: unique symbol;
export type FactSetId = string & { readonly [factSetIdBrand]: true };
export const FactSetId = {
  parse(input: unknown): FactSetId { return uuidSchema.parse(input) as FactSetId; },
  unsafeFrom(value: string): FactSetId { return value as FactSetId; }
};

// CategoryPath is a slash-delimited string, e.g. "Apparel/Tops/T-Shirts"
declare const categoryPathBrand: unique symbol;
export type CategoryPath = string & { readonly [categoryPathBrand]: true };
export const CategoryPath = {
  parse(input: unknown): CategoryPath {
    return z.string().min(1).parse(input) as CategoryPath;
  },
  unsafeFrom(value: string): CategoryPath { return value as CategoryPath; }
};

// CanonicalKey is the dotted attribute key, e.g. "product.brand"
declare const canonicalKeyBrand: unique symbol;
export type CanonicalKey = string & { readonly [canonicalKeyBrand]: true };
export const CanonicalKey = {
  parse(input: unknown): CanonicalKey {
    return z.string().min(1).parse(input) as CanonicalKey;
  },
  unsafeFrom(value: string): CanonicalKey { return value as CanonicalKey; }
};
