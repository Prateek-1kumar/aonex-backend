import { describe, it, expect } from "bun:test";
import { recordLadderRung, type LadderRung } from "./ladder-logger.js";
import type { AuditEmitter, AuditEventInput } from "@aonex/audit";
import type { TenantId } from "@aonex/types";

function makeSpyEmitter(): { emitter: AuditEmitter; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return {
    emitter: { async emit(event) { events.push(event); } },
    events
  };
}

describe("recordLadderRung", () => {
  it("emits ladder.rung_fired with rung + domain metadata", async () => {
    const { emitter, events } = makeSpyEmitter();
    await recordLadderRung({
      audit: emitter,
      field: "base_price",
      rung: "dom_heuristic",
      domain: "decathlon.com",
      parserVersion: "dom-heuristics@1.0.0",
      tenantId: "t-1" as TenantId
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("ladder.rung_fired");
    expect(events[0]!.entityType).toBe("field");
    expect(events[0]!.entityId).toBe("base_price");
    const meta = events[0]!.metadata!;
    expect(meta.rung).toBe("dom_heuristic");
    expect(meta.domain).toBe("decathlon.com");
    expect(meta.parserVersion).toBe("dom-heuristics@1.0.0");
  });

  it("accepts all 17 LadderRung values as the rung parameter", async () => {
    const { emitter, events } = makeSpyEmitter();
    const allRungs: LadderRung[] = [
      "json_ld", "microdata", "opengraph", "nuxt", "next_data", "initial_state",
      "shopify_probe", "shopify_products_json", "magento", "woocommerce", "algolia",
      "rdfa", "breadcrumb_list", "dom_heuristic", "per_site_parser",
      "llm_gap_fill", "vision_llm"
    ];
    for (const rung of allRungs) {
      await recordLadderRung({
        audit: emitter,
        field: "title",
        rung,
        domain: "x.com",
        parserVersion: "v",
        tenantId: "t" as TenantId
      });
    }
    expect(events).toHaveLength(17);
  });
});
