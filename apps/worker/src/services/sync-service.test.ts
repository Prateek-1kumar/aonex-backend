import { describe, it, expect } from 'bun:test';
import { SyncService } from './sync-service.js';

function makeMockDb(insertedIds: string[]) {
  let callCount = 0;
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const id = insertedIds[callCount++];
            return Promise.resolve(id ? [{ id }] : []);
          }
        })
      })
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) })
  };
}

function makeMockQueue() {
  const jobs: string[] = [];
  return {
    add: (_kind: string, data: { artifactId: string }, _opts: unknown) => {
      jobs.push(data.artifactId);
      return Promise.resolve();
    },
    _jobs: jobs
  };
}

describe('SyncService.persistArtifacts', () => {
  it('inserts new artifacts and enqueues extract jobs', async () => {
    const extractQueue = makeMockQueue();
    const db = makeMockDb(['artifact-1', 'artifact-2']);
    const service = new SyncService({ db: db as any, extractQueue: extractQueue as any });

    const result = await service.persistArtifacts({
      tenantId: 'tenant-1' as any,
      merchantId: 'merchant-1' as any,
      marketplace: 'shopify',
      syncJobRunId: 'run-1',
      records: [
        { externalId: 'prod-1', raw: { id: 'prod-1', title: 'A' } },
        { externalId: 'prod-2', raw: { id: 'prod-2', title: 'B' } }
      ]
    });

    expect(result.inserted).toBe(2);
    expect(extractQueue._jobs).toEqual(['artifact-1', 'artifact-2']);
  });

  it('skips duplicate artifacts (onConflictDoNothing returns empty)', async () => {
    const extractQueue = makeMockQueue();
    const db = makeMockDb([]); // all conflict → no inserts
    const service = new SyncService({ db: db as any, extractQueue: extractQueue as any });

    const result = await service.persistArtifacts({
      tenantId: 'tenant-1' as any,
      merchantId: 'merchant-1' as any,
      marketplace: 'shopify',
      syncJobRunId: 'run-1',
      records: [{ externalId: 'prod-1', raw: { id: 'prod-1' } }]
    });

    expect(result.inserted).toBe(0);
    expect(extractQueue._jobs).toHaveLength(0);
  });
});
