// ShopifyAdapter — provider-native implementation via Nango proxy.
//
// WHY: All Shopify API calls route through the Nango proxy
// (${nangoHost}/proxy/...) so token management, refresh, and shop
// domain resolution stay in Nango — the adapter never touches raw
// credentials. Changing SHOPIFY_API_VERSION or switching to GraphQL
// happens here without touching any business code.

import type { OAuthUrlResult, CreateOAuthUrlInput, InventoryRecord } from '../../contract/index.js';
import { GatewayError, type GatewayErrorKind, type Marketplace, type MerchantId } from '@aonex/types';

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
  maxPages?: number;
}

export interface GetInventoryByConnectionInput {
  connection: ConnectionContext;
  externalProductId: string;
}

export interface ShopifyAdapterConfig {
  /** Nango Connect UI base URL — where merchants land to connect their store. */
  nangoConnectBaseUrl: string;
  transport: ShopifyTransport;
}

export interface MarketplaceLiveAdapter {
  createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult>;
  healthCheck(input: { connection: ConnectionContext }): Promise<boolean>;
  listProducts(input: ListProductsInput): Promise<ProviderProduct[]>;
  getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]>;
}

export interface ShopifyTransport {
  request(connection: ConnectionContext, path: string, init?: RequestInit): Promise<Response>;
}

export interface NangoProxyShopifyTransportConfig {
  /** Nango API host, e.g. https://api.nango.dev (from NANGO_HOST env). */
  nangoHost: string;
  /** Nango secret key for proxy Authorization header (from NANGO_SECRET_KEY env). */
  nangoSecretKey: string;
}

export class NangoProxyShopifyTransport implements ShopifyTransport {
  constructor(private readonly config: NangoProxyShopifyTransportConfig) {}

  request(connection: ConnectionContext, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.nangoHost}/proxy${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.config.nangoSecretKey}`,
        'Connection-Id': connection.connectionId,
        'Provider-Config-Key': 'shopify',
        ...(init?.headers as Record<string, string> ?? {})
      }
    });
  }
}

export class ShopifyAdapter implements MarketplaceLiveAdapter {
  constructor(private readonly config: ShopifyAdapterConfig) {}

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
    const res = await this.config.transport.request(
      input.connection,
      `/admin/api/${SHOPIFY_API_VERSION}/shop.json`
    );
    return res.ok;
  }

  // ── Ingestion ─────────────────────────────────────────────────────────

  async listProducts(input: ListProductsInput): Promise<ProviderProduct[]> {
    const limit = input.limit ?? 50;
    const maxPages = input.maxPages ?? 25;
    const products: ProviderProduct[] = [];
    let pageInfo: string | undefined;
    let page = 0;

    do {
      page += 1;
      const path = pageInfo
        ? `/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=${limit}&page_info=${encodeURIComponent(pageInfo)}`
        : `/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=${limit}`;
      const res = await this.config.transport.request(input.connection, path);
      await assertOk(res, 'listProducts');
      const data = await res.json() as { products?: Array<{ id: number | string; [k: string]: unknown }> };
      for (const product of data.products ?? []) {
        products.push({
          externalId: String(product.id),
          raw: product
        });
      }
      pageInfo = nextPageInfo(res.headers.get('link'));
    } while (pageInfo && page < maxPages);

    return products;
  }

  async getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]> {
    const res = await this.config.transport.request(
      input.connection,
      `/admin/api/${SHOPIFY_API_VERSION}/products/${input.externalProductId}.json`
    );
    if (res.status === 404) return [];
    await assertOk(res, 'getInventory');
    const data = await res.json() as {
      product: { variants: Array<{ id: number; inventoryQuantity?: number; inventory_quantity?: number }> }
    };
    return (data.product.variants ?? []).map((v) => ({
      locationId: String(v.id),
      available: v.inventoryQuantity ?? v.inventory_quantity ?? 0
    }));
  }

  // ── Distribution ──────────────────────────────────────────────────────

  async publishListing(input: { connection: ConnectionContext; payload: unknown }): Promise<{ success: boolean; externalListingId?: string }> {
    const res = await this.config.transport.request(
      input.connection,
      `/admin/api/${SHOPIFY_API_VERSION}/products.json`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.payload) }
    );
    await assertOk(res, 'publishListing');
    const data = await res.json() as { product: { id: number } };
    return { success: true, externalListingId: String(data.product.id) };
  }
}

async function assertOk(res: Response, operation: string): Promise<void> {
  if (res.ok) return;
  const body = await safeErrorBody(res);
  const retryAfter = retryAfterMs(res.headers.get('retry-after'));
  const opts: { providerStatus: number; retryAfterMs?: number; cause?: unknown } = {
    providerStatus: res.status
  };
  if (retryAfter !== undefined) opts.retryAfterMs = retryAfter;
  if (body !== undefined) opts.cause = body;
  throw new GatewayError(kindForStatus(res.status), `Shopify ${operation} failed with HTTP ${res.status}`, opts);
}

function kindForStatus(status: number): GatewayErrorKind {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_5xx';
  if (status >= 400) return 'provider_4xx';
  return 'internal';
}

async function safeErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function nextPageInfo(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const [urlPart, ...params] = part.split(';').map((s) => s.trim());
    if (!params.some((p) => p === 'rel="next"')) continue;
    const match = /^<(.+)>$/.exec(urlPart ?? '');
    if (!match) continue;
    try {
      const url = match[1];
      if (!url) continue;
      return new URL(url).searchParams.get('page_info') ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
