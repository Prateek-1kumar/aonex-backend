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
