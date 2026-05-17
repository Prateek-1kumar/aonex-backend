/**
 * Spec §6.4 — ScrapingBee unlock-API adapter. We never construct the real
 * SDK at import time (would error if SCRAPINGBEE_API_KEY is unset). Callers
 * inject the client via createScrapingBeeAdapter (real or stub).
 */
export interface ScrapingBeeGetParams {
  url: string;
  params: Record<string, unknown>;
}

export interface ScrapingBeeResponse {
  data: Buffer | string;
  headers: Record<string, string>;
}

export interface ScrapingBeeClient {
  get(params: ScrapingBeeGetParams): Promise<ScrapingBeeResponse>;
}

export interface UnblockOptions {
  premiumProxy?: boolean;
  jsRendering?: boolean;
  countryCode?: string;
}

export interface UnblockResult {
  rawHtml: string;
  finalUrl: string;
  costCredits: number;
  durationMs: number;
}

export interface ScrapingBeeAdapter {
  unblock(url: string, opts?: UnblockOptions): Promise<UnblockResult>;
}

export function createScrapingBeeAdapter(client: ScrapingBeeClient): ScrapingBeeAdapter {
  return {
    async unblock(url, opts): Promise<UnblockResult> {
      const start = Date.now();
      const params: Record<string, unknown> = {
        render_js: opts?.jsRendering !== false,    // default true
        premium_proxy: opts?.premiumProxy ?? false,
        country_code: opts?.countryCode ?? "us"
      };
      const response = await client.get({ url, params });
      const html = typeof response.data === "string"
        ? response.data
        : response.data.toString("utf-8");
      const costHeader = response.headers["spb-cost"] ?? "1";
      const cost = Number(costHeader);
      return {
        rawHtml: html,
        finalUrl: response.headers["spb-resolved-url"] ?? url,
        costCredits: Number.isFinite(cost) ? cost : 1,
        durationMs: Date.now() - start
      };
    }
  };
}

/**
 * Convenience wrapper that constructs the real ScrapingBee SDK client.
 * THIS WILL THROW if SCRAPINGBEE_API_KEY is unset — caller checks env first.
 *
 * NOT exercised in this phase (Layer D scaffold-only per user decision).
 * Used by Phase 7+ runtime wiring once a key is provisioned.
 *
 * SDK note (v1.8.2): the package is CommonJS and exports ScrapingBeeClient as
 * a named export — NOT wrapped under a `.default` property. Under Bun/Node
 * ESM-CJS interop the import resolves as either a named export or the module
 * object itself depending on the bundler. We check both forms defensively.
 *
 * Deviation from prompt: prompt showed `scrapingbee.default?.ScrapingBeeClient`
 * but the v1.8.2 dist uses `exports.ScrapingBeeClient` (named, no default
 * wrapper), so we first try the named-export path and fall back to .default.
 */
export async function createRealScrapingBeeClient(apiKey: string): Promise<ScrapingBeeClient> {
  const mod = await import("scrapingbee");
  // CJS named-export shape (v1.8.2): mod.ScrapingBeeClient
  // Some bundlers may wrap it under mod.default — check both.
  type ModShape = {
    ScrapingBeeClient?: new (key: string) => unknown;
    default?: { ScrapingBeeClient?: new (key: string) => unknown };
  };
  const m = mod as ModShape;
  const ClientCtor =
    m.ScrapingBeeClient ??
    m.default?.ScrapingBeeClient;
  if (!ClientCtor) {
    throw new Error("scrapingbee SDK did not expose ScrapingBeeClient — check SDK version");
  }
  const raw = new ClientCtor(apiKey);
  return raw as ScrapingBeeClient;
}

/**
 * Convenience wrapper that uses the real ScrapingBee SDK. Intentionally
 * not invoked in Phase 6 unit tests; flip on when SCRAPINGBEE_API_KEY ships.
 */
export async function unblockWithScrapingBee(url: string, opts?: UnblockOptions): Promise<UnblockResult> {
  const apiKey = process.env["SCRAPINGBEE_API_KEY"];
  if (!apiKey) {
    throw new Error("SCRAPINGBEE_API_KEY is required to call unblockWithScrapingBee");
  }
  const client = await createRealScrapingBeeClient(apiKey);
  return createScrapingBeeAdapter(client).unblock(url, opts);
}
