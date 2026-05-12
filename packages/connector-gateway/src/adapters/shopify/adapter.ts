// ShopifyAdapter — provider-native implementation via Nango proxy.
//
// WHY: All Shopify API calls route through the Nango proxy
// (${nangoHost}/proxy/...) so token management, refresh, and shop
// domain resolution stay in Nango — the adapter never touches raw
// credentials. Changing SHOPIFY_API_VERSION or switching to GraphQL
// happens here without touching any business code.

import type { OAuthUrlResult, CreateOAuthUrlInput, InventoryRecord } from '../../contract/index.js';
import type { Marketplace, MerchantId } from '@aonex/types';

const SHOPIFY_API_VERSION = '2025-01';

export interface ConnectionContext {
  tenantId: string;
  merchantId: MerchantId;
  marketplace: Marketplace;
  /** Nango providerConnectionId — passed as Connection-Id to the proxy. */
  connectionId: string;
}

export interface ProviderProduct {
  externalId: string;
  raw: unknown;
}

export interface ListProductsInput {
  connection: ConnectionContext;
  limit?: number;
}

export interface GetInventoryByConnectionInput {
  connection: ConnectionContext;
  externalProductId: string;
}

export interface ShopifyAdapterConfig {
  /** Nango Connect UI base URL — where merchants land to connect their store. */
  nangoConnectBaseUrl: string;
  /** Nango API host, e.g. https://api.nango.dev (from NANGO_HOST env). */
  nangoHost: string;
  /** Nango secret key for proxy Authorization header (from NANGO_SECRET_KEY env). */
  nangoSecretKey: string;
}

export class ShopifyAdapter {
  constructor(private readonly config: ShopifyAdapterConfig) {}

  // ── Proxy helper ──────────────────────────────────────────────────────

  private proxyFetch(connectionId: string, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.nangoHost}/proxy${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.config.nangoSecretKey}`,
        'Connection-Id': connectionId,
        'Provider-Config-Key': 'shopify',
        ...(init?.headers as Record<string, string> ?? {})
      }
    });
  }

  // ── OAuth ─────────────────────────────────────────────────────────────

  async createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult> {
    const url = `${this.config.nangoConnectBaseUrl}?session_token=${input.sessionToken}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    return { url, expiresAt };
  }

  async exchangeCodeForToken(_input: { code: string; shopDomain: string }): Promise<{ accessToken: string; scopes: string[] }> {
    return { accessToken: '', scopes: [] };
  }

  // ── Health ────────────────────────────────────────────────────────────

  async healthCheck(input: { connection: ConnectionContext }): Promise<boolean> {
    const res = await this.proxyFetch(
      input.connection.connectionId,
      `/admin/api/${SHOPIFY_API_VERSION}/shop.json`
    );
    return res.ok;
  }

  // ── Ingestion ─────────────────────────────────────────────────────────

  async listProducts(input: ListProductsInput): Promise<ProviderProduct[]> {
    const limit = input.limit ?? 50;
    const res = await this.proxyFetch(
      input.connection.connectionId,
      `/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=${limit}`
    );
    if (!res.ok) throw new Error('SHOPIFY_PRODUCTS_FETCH_FAILED');
    const data = await res.json() as { products: Array<{ id: number | string; [k: string]: unknown }> };
    return data.products.map((product) => ({
      externalId: String(product.id),
      raw: product
    }));
  }

  async getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]> {
    const res = await this.proxyFetch(
      input.connection.connectionId,
      `/admin/api/${SHOPIFY_API_VERSION}/products/${input.externalProductId}.json`
    );
    if (!res.ok) return [];
    const data = await res.json() as {
      product: { variants: Array<{ id: number; inventoryQuantity: number }> }
    };
    return (data.product.variants ?? []).map((v) => ({
      locationId: String(v.id),
      available: v.inventoryQuantity ?? 0
    }));
  }

  // ── Distribution ──────────────────────────────────────────────────────

  async publishListing(input: { connection: ConnectionContext; payload: unknown }): Promise<{ success: boolean; externalListingId?: string }> {
    const res = await this.proxyFetch(
      input.connection.connectionId,
      `/admin/api/${SHOPIFY_API_VERSION}/products.json`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.payload) }
    );
    if (!res.ok) throw new Error('SHOPIFY_PUBLISH_FAILED');
    const data = await res.json() as { product: { id: number } };
    return { success: true, externalListingId: String(data.product.id) };
  }
}
