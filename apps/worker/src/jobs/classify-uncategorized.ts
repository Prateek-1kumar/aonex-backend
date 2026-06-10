// Cron sweep: classify catalog products that have no category_node_id yet and
// assign it, so newly-ingested products get categorized within the sweep window
// (P1.3c). Alias hits auto-assign; the rest (propose_node / abstain) stay
// uncategorized and surface in the Lab. Uses the deterministic resolver — no LLM
// cost on the sweep; the LLM runs in the Lab "suggest" flow.
//
// Exports runClassifyUncategorized (testable core) + classifyUncategorized
// (the CronJob registered in jobs/index.ts).

import { schema, type DrizzleClient } from "@aonex/db";
import { eq, isNull } from "drizzle-orm";
import { buildIndex, classifyWithFallback, deterministicResolver, type ProductSignals } from "@aonex/taxonomy-classifier";
import type { Logger } from "pino";
import type { CronJob } from "./index.js";

/** winning_values are channel/locale-scoped: {channel: {locale: value}}. Take the first. */
function firstScoped(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v ?? null;
  const ch = Object.values(v as Record<string, unknown>)[0];
  if (ch == null || typeof ch !== "object") return ch ?? null;
  return Object.values(ch as Record<string, unknown>)[0] ?? null;
}
const asText = (v: unknown): string => (Array.isArray(v) ? v.join(" > ") : v == null ? "" : String(v));

export interface ClassifySweepResult {
  examined: number;
  assigned: number;
  proposed: number;
  abstained: number;
}

/** Classify every catalog product with a null category_node_id; assign on a
 *  confident result. Pure DB work — no LLM. */
export async function runClassifyUncategorized(db: DrizzleClient, logger?: Logger): Promise<ClassifySweepResult> {
  const nodes = await db.select().from(schema.taxonomyNodes);
  if (nodes.length === 0) return { examined: 0, assigned: 0, proposed: 0, abstained: 0 };
  const aliasMap = new Map((await db.select().from(schema.taxonomyAliases)).map((a) => [a.normalizedLabel, a.nodeId]));
  const index = buildIndex(
    nodes.filter((n) => n.isLeaf).map((n) => ({ nodeId: n.nodeId, displayName: n.displayName })),
    aliasMap,
    nodes.filter((n) => n.level === 0).map((n) => ({ id: n.nodeId, name: n.displayName }))
  );

  const products = await db
    .select()
    .from(schema.catalogProducts)
    .where(isNull(schema.catalogProducts.categoryNodeId));

  const res: ClassifySweepResult = { examined: products.length, assigned: 0, proposed: 0, abstained: 0 };
  for (const p of products) {
    const wv = (p.winningValues ?? {}) as Record<string, unknown>;
    const identity = (p.identity ?? {}) as Record<string, unknown>;
    const signals: ProductSignals = {
      title: asText(firstScoped(wv.title)),
      sourceCategory: asText(firstScoped(wv.category_path)),
      ...(identity.brand ? { brand: String(identity.brand) } : {}),
    };
    const r = await classifyWithFallback(signals, index, deterministicResolver);
    if (r.outcome === "assign" && r.nodeId) {
      await db.update(schema.catalogProducts).set({ categoryNodeId: r.nodeId, categorySource: "auto" }).where(eq(schema.catalogProducts.productId, p.productId));
      res.assigned++;
    } else if (r.outcome === "propose_node") {
      res.proposed++;
    } else {
      res.abstained++;
    }
  }
  logger?.info({ ...res }, "classify-uncategorized sweep");
  return res;
}

export const classifyUncategorized: CronJob = {
  name: "classify-uncategorized",
  cronSchedule: "*/15 * * * *",
  process: async (ctx) => {
    await runClassifyUncategorized(ctx.db, ctx.logger);
  },
};
