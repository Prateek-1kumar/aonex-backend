import type {
  ConnectionContext,
  MarketplaceLiveAdapter,
  ProviderProduct,
  ListProductsInput,
  GetInventoryByConnectionInput
} from '../../contract/provider-adapter.js';
import type { OAuthUrlResult, CreateOAuthUrlInput, InventoryRecord } from '../../contract/index.js';
import { GatewayError, type GatewayErrorKind } from '@aonex/types';

export interface EbayTransport {
  request(connection: ConnectionContext, path: string, init?: RequestInit): Promise<Response>;
}

export interface NangoProxyEbayTransportConfig {
  /** Nango API host, e.g. https://api.nango.dev (from NANGO_HOST env). */
  nangoHost: string;
  /** Nango secret key for proxy Authorization header (from NANGO_SECRET_KEY env). */
  nangoSecretKey: string;
  /** eBay API base URL — use sandbox URL in non-production environments. */
  ebayApiBaseUrl?: string;
}

export class NangoProxyEbayTransport implements EbayTransport {
  constructor(private readonly config: NangoProxyEbayTransportConfig) {}

  request(connection: ConnectionContext, path: string, init?: RequestInit): Promise<Response> {
    const baseUrl = this.config.ebayApiBaseUrl ?? 'https://api.ebay.com';
    return fetch(`${this.config.nangoHost}/proxy${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.config.nangoSecretKey}`,
        'Connection-Id': connection.connectionId,
        'Provider-Config-Key': 'ebay-sandbox',
        'Baseurl-Override': baseUrl,
        ...(init?.headers as Record<string, string> ?? {})
      }
    });
  }
}

export interface EbayAdapterConfig {
  /** Nango Connect UI base URL — where merchants land to connect their eBay account. */
  nangoConnectBaseUrl: string;
  transport: EbayTransport;
}

export class EbayAdapter implements MarketplaceLiveAdapter {
  constructor(private readonly config: EbayAdapterConfig) {}

  // ── OAuth ─────────────────────────────────────────────────────────────

  async createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult> {
    const url = `${this.config.nangoConnectBaseUrl}?session_token=${input.sessionToken}`;
    return { url, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
  }

  // ── Health ────────────────────────────────────────────────────────────

  async healthCheck(input: { connection: ConnectionContext }): Promise<boolean> {
    const res = await this.config.transport.request(
      input.connection,
      '/sell/inventory/v1/inventory_item?limit=1'
    );
    return res.ok;
  }

  // ── Ingestion ─────────────────────────────────────────────────────────

  async listProducts(input: ListProductsInput): Promise<ProviderProduct[]> {
    const limit = input.limit ?? 100;
    const maxPages = input.maxPages ?? 25;
    const products: ProviderProduct[] = [];
    let offset = 0;
    let page = 0;

    do {
      page++;
      const res = await this.config.transport.request(
        input.connection,
        `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`
      );
      await assertOk(res, 'listProducts');
      const data = await res.json() as {
        inventoryItems?: Array<{ sku: string; [k: string]: unknown }>;
        total?: number;
      };
      for (const item of data.inventoryItems ?? []) {
        products.push({ externalId: item.sku, raw: item });
      }
      const total = data.total ?? 0;
      offset += limit;
      if (offset >= total) break;
    } while (page < maxPages);

    return products;
  }

  async getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]> {
    const res = await this.config.transport.request(
      input.connection,
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.externalProductId)}`
    );
    if (res.status === 404) return [];
    await assertOk(res, 'getInventory');
    const data = await res.json() as {
      availability?: { shipToLocationAvailability?: { quantity?: number } };
    };
    const quantity = data.availability?.shipToLocationAvailability?.quantity ?? 0;
    return [{ locationId: 'default', available: quantity }];
  }
}

async function assertOk(res: Response, operation: string): Promise<void> {
  if (res.ok) return;
  const body = await safeBody(res);
  const kind = kindForStatus(res.status);
  const retryAfter = retryAfterMs(res.headers.get('retry-after'));
  const opts: { providerStatus: number; retryAfterMs?: number; cause?: unknown } = {
    providerStatus: res.status
  };
  if (retryAfter !== undefined) opts.retryAfterMs = retryAfter;
  if (body !== undefined) opts.cause = body;
  throw new GatewayError(kind, `eBay ${operation} failed with HTTP ${res.status}`, opts);
}

function kindForStatus(status: number): GatewayErrorKind {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_5xx';
  if (status >= 400) return 'provider_4xx';
  return 'internal';
}

async function safeBody(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()) || undefined;
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
