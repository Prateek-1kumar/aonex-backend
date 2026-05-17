import { describe, it, expect } from "bun:test";
import { recordSelectorFiring } from "./counter.js";
import type { AuditEmitter, AuditEventInput } from "@aonex/audit";
import type { TenantId } from "@aonex/types";

function makeSpyEmitter(): { emitter: AuditEmitter; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return {
    emitter: { async emit(event: AuditEventInput) { events.push(event); } },
    events
  };
}

describe("recordSelectorFiring", () => {
  it("emits selector.fired audit event with domain + success metadata", async () => {
    const { emitter, events } = makeSpyEmitter();
    await recordSelectorFiring({
      audit: emitter,
      selectorId: "json_ld.product.name",
      domain: "decathlon.com",
      success: true,
      parserVersion: "json-ld@1.0.0",
      tenantId: "t-1" as TenantId
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("selector.fired");
    expect(events[0]!.entityId).toBe("json_ld.product.name");
    expect(events[0]!.entityType).toBe("selector");
    expect(events[0]!.metadata).toEqual({
      domain: "decathlon.com",
      success: true,
      parserVersion: "json-ld@1.0.0"
    });
  });

  it("propagates tenantId for multi-tenant slicing", async () => {
    const { emitter, events } = makeSpyEmitter();
    await recordSelectorFiring({
      audit: emitter,
      selectorId: "x",
      domain: "y.com",
      success: false,
      parserVersion: "v",
      tenantId: "tenant-42" as TenantId
    });
    expect(events[0]!.tenantId).toBe("tenant-42" as TenantId);
  });

  it("uses actorType=worker (audit-plane convention)", async () => {
    const { emitter, events } = makeSpyEmitter();
    await recordSelectorFiring({
      audit: emitter,
      selectorId: "x",
      domain: "y.com",
      success: true,
      parserVersion: "v",
      tenantId: "t" as TenantId
    });
    expect(events[0]!.actorType).toBe("worker");
  });
});
