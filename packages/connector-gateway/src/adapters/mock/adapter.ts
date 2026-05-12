// MockConnectorAdapter — a Fake (working in-memory implementation),
// not a Mock per the test-doubles taxonomy. The contract test runs
// against this AND NangoConnectorAdapter; if Mock passes and Nango
// fails, Nango violates LSP. (Engineering principles, "LSP via
// contract tests".)
//
// Used in:
//  - Phase 1 dev (run api+worker without Nango Cloud)
//  - All unit tests
//  - The contract test suite

import { createHmac } from "node:crypto";
import { sha256Hex } from "@aonex/lib-utils";
import {
  ConnectionId as ConnectionIdParse,
  GatewayError,
  NangoWebhookEventSchema,
  type Marketplace,
  type MerchantId,
  type TenantId
} from "@aonex/types";
import type {
  CanonicalProductRecord,
  ConnectionDescriptor,
  ConnectSessionToken,
  ConnectorAdapterPhase1,
  ConnectorCapabilities,
  CreateConnectSessionInput,
  DrainOptions,
  FetchRecordInput,
  ListRecordsInput,
  ListRecordsResult,
  SyncStatus,
  TokenHealthResult,
  VerifyAndParseInput,
  VerifyAndParseResult,
  OAuthUrlResult,
  CreateOAuthUrlInput,
  GetInventoryInput,
  InventoryRecord
} from "../../contract/index.js";

interface SeededRecord {
  externalId: string;
  raw: Record<string, unknown>;
  modifiedAt?: Date;
}

export interface MockConnectorAdapterDeps {
  webhookSecret: string;
}

export class MockConnectorAdapter implements ConnectorAdapterPhase1 {
  /** key = merchantId|marketplace */
  private readonly connections = new Map<string, ConnectionDescriptor>();
  /** key = merchantId|marketplace, value = ordered records */
  private readonly records = new Map<string, SeededRecord[]>();
  /** key = sync session token */
  private readonly sessions = new Map<string, { merchantId: MerchantId; expiresAt: Date }>();

  constructor(private readonly deps: MockConnectorAdapterDeps) {}

  // -------- test helpers (not on the interface) ------------------

  static key(merchantId: MerchantId, marketplace: Marketplace): string {
    return `${merchantId}|${marketplace}`;
  }

  /** Seed an active connection for tests. */
  seedConnection(d: ConnectionDescriptor): void {
    this.connections.set(MockConnectorAdapter.key(d.merchantId, d.marketplace), d);
  }

  /** Seed records the next drain will return. */
  seedRecords(
    merchantId: MerchantId,
    marketplace: Marketplace,
    records: SeededRecord[]
  ): void {
    this.records.set(MockConnectorAdapter.key(merchantId, marketplace), records);
  }

  /**
   * Compute the HMAC header a real Nango payload would carry, so
   * tests can build a verifying webhook without duplicating the
   * verifier's logic.
   */
  signWebhookBody(rawBody: string): string {
    return createHmac("sha256", this.deps.webhookSecret).update(rawBody).digest("hex");
  }

  // -------- Read -------------------------------------------------

  async capabilities(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<ConnectorCapabilities> {
    return { marketplace: input.marketplace, syncs: ["mock-products"], canPublish: false };
  }

  async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
    this.assertConnection(input.merchantId, input.marketplace);
    const all = this.records.get(MockConnectorAdapter.key(input.merchantId, input.marketplace)) ?? [];
    const filtered = input.modifiedAfter
      ? all.filter((r) => !r.modifiedAt || r.modifiedAt > (input.modifiedAfter as Date))
      : all;
    const start = input.cursor ? Number(input.cursor) : 0;
    const limit = input.pageSize ?? 100;
    const slice = filtered.slice(start, start + limit);
    const result: ListRecordsResult = {
      page: {
        records: slice.map((r) => ({
          externalId: r.externalId,
          marketplace: input.marketplace,
          raw: r.raw,
          ...(r.modifiedAt ? { modifiedAt: r.modifiedAt } : {})
        }))
      }
    };
    if (start + slice.length < filtered.length) {
      result.page = { ...result.page, nextCursor: String(start + slice.length) };
    }
    return result;
  }

  async fetchRecord(input: FetchRecordInput): Promise<CanonicalProductRecord> {
    this.assertConnection(input.merchantId, input.marketplace);
    const all = this.records.get(MockConnectorAdapter.key(input.merchantId, input.marketplace)) ?? [];
    const r = all.find((x) => x.externalId === input.externalId);
    if (!r) {
      throw new GatewayError(
        "connection_not_found",
        `Mock has no record ${input.externalId} for ${input.marketplace}`
      );
    }
    return {
      externalId: r.externalId,
      marketplace: input.marketplace,
      raw: r.raw,
      ...(r.modifiedAt ? { modifiedAt: r.modifiedAt } : {})
    };
  }

  async *drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts: DrainOptions = {}
  ): AsyncIterable<CanonicalProductRecord[]> {
    let cursor: string | undefined;
    while (true) {
      const result = await this.listRecords({
        merchantId: input.merchantId,
        marketplace: input.marketplace,
        ...(opts.modifiedAfter ? { modifiedAfter: opts.modifiedAfter } : {}),
        ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
        ...(cursor ? { cursor } : {})
      });
      if (result.page.records.length > 0) {
        yield [...result.page.records];
      }
      if (!result.page.nextCursor) break;
      cursor = result.page.nextCursor;
    }
  }

  async getSyncStatus(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<SyncStatus> {
    this.assertConnection(input.merchantId, input.marketplace);
    const all = this.records.get(MockConnectorAdapter.key(input.merchantId, input.marketplace)) ?? [];
    return {
      marketplace: input.marketplace,
      recordsAdded: all.length,
      recordsUpdated: 0,
      recordsFailed: 0,
      lastSyncMode: "INCREMENTAL"
    };
  }

  // -------- Admin -------------------------------------------------

  async createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSessionToken> {
    const token = `mock-session-${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    this.sessions.set(token, { merchantId: input.merchantId, expiresAt });
    return { token, expiresAt };
  }

  async getConnection(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<ConnectionDescriptor | null> {
    return this.connections.get(MockConnectorAdapter.key(input.merchantId, input.marketplace)) ?? null;
  }

  async listConnections(input: {
    merchantId: MerchantId;
  }): Promise<readonly ConnectionDescriptor[]> {
    return [...this.connections.values()].filter((c) => c.merchantId === input.merchantId);
  }

  async revoke(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<void> {
    const k = MockConnectorAdapter.key(input.merchantId, input.marketplace);
    const existing = this.connections.get(k);
    if (existing) {
      this.connections.set(k, { ...existing, status: "revoked" });
    }
    // Idempotent — calling twice is not an error.
  }

  async refreshTokenHealth(): Promise<TokenHealthResult> {
    return { healthy: true };
  }

  async createOAuthUrl(_input: CreateOAuthUrlInput): Promise<OAuthUrlResult> {
    return { url: 'https://connect.nango.dev?token=mock', expiresAt: new Date(Date.now() + 600_000) };
  }

  async healthCheck(_input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<boolean> {
    return true;
  }

  async getInventory(_input: GetInventoryInput): Promise<readonly InventoryRecord[]> {
    return [];
  }

  // -------- Webhook ----------------------------------------------

  async verifyAndParseWebhook(input: VerifyAndParseInput): Promise<VerifyAndParseResult> {
    const sig = lookupHeader(input.headers, "x-nango-hmac-sha256");
    const expected = createHmac("sha256", this.deps.webhookSecret).update(input.rawBody).digest("hex");
    if (sig !== expected) {
      throw new GatewayError("invalid_signature", "Mock HMAC mismatch");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody);
    } catch {
      throw new GatewayError("invalid_payload", "Webhook body is not valid JSON");
    }
    const result = NangoWebhookEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new GatewayError("invalid_payload", `Schema failed: ${result.error.message}`);
    }
    return { event: result.data, webhookId: sha256Hex(input.rawBody) };
  }

  // -------- internal ---------------------------------------------

  private assertConnection(merchantId: MerchantId, marketplace: Marketplace): void {
    const c = this.connections.get(MockConnectorAdapter.key(merchantId, marketplace));
    if (!c) {
      throw new GatewayError(
        "connection_not_found",
        `Mock has no connection for merchant=${merchantId} marketplace=${marketplace}`
      );
    }
    if (c.status !== "active") {
      throw new GatewayError("connection_revoked", `Mock connection status=${c.status}`);
    }
  }
}

function lookupHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
