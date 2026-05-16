import { describe, it, expect } from "bun:test";
import { persistArtifact } from "./persist-artifact.js";
import type { IngestionEnvelope } from "../adapter.js";

function makeMockDb() {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            inserts.push(v);
            return Promise.resolve([{ id: `art-${inserts.length}` }]);
          }
        })
      })
    }),
    _inserts: inserts
  };
}

const envelope: IngestionEnvelope = {
  sourceExternalId: "https://example.com/p/1",
  sourceType: "link_url",
  sourceMarketplace: null,
  rawData: { html: "<html>...</html>", title: "Test" },
  checksum: "abc123"
};

describe("persistArtifact", () => {
  it("inserts source_artifact with envelope contents and returns artifact id", async () => {
    const db = makeMockDb();
    const result = await persistArtifact({
      db: db as never,
      tenantId: "tenant-1" as never,
      merchantId: "merchant-1" as never,
      envelope
    });

    expect(result.artifactId).toBe("art-1" as never);
    expect(result.duplicateOfChecksum).toBe(null);
    const row = db._inserts[0]!;
    expect(row.sourceType).toBe("link_url");
    expect(row.sourceExternalId).toBe("https://example.com/p/1");
    expect(row.checksum).toBe("abc123");
    expect(row.status).toBe("processing");
  });

  it("returns null artifactId + duplicateOfChecksum when onConflict skips insert", async () => {
    const dupDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([])    // conflict
          })
        })
      })
    };
    const result = await persistArtifact({
      db: dupDb as never,
      tenantId: "tenant-1" as never,
      merchantId: "merchant-1" as never,
      envelope
    });

    expect(result.artifactId).toBe(null);
    expect(result.duplicateOfChecksum).toBe("abc123");
  });
});
