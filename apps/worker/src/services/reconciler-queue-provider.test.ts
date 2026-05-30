import { afterAll, describe, expect, test } from "bun:test";
import IORedis from "ioredis";
import { reconcilerQueueName } from "@aonex/catalog-service";
import { ReconcilerQueueProvider } from "./reconciler-queue-provider.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("ReconcilerQueueProvider", () => {
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const provider = new ReconcilerQueueProvider(connection);

  afterAll(async () => {
    await provider.close();
    await connection.quit();
  });

  test("forTenant returns a Queue named recon.<tenantId>", () => {
    const q = provider.forTenant("11111111-1111-1111-1111-111111111111");
    expect(q.name).toBe(reconcilerQueueName("11111111-1111-1111-1111-111111111111"));
  });

  test("forTenant caches one Queue per tenant", () => {
    const a = provider.forTenant("22222222-2222-2222-2222-222222222222");
    const b = provider.forTenant("22222222-2222-2222-2222-222222222222");
    expect(a).toBe(b);
  });
});
