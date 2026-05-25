// Anomaly Lab HTTP handlers — thin wrappers over @aonex/catalog-service staging fns.
import type { Context } from "hono";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema } from "@aonex/db";
import { TenantId } from "@aonex/types";
import type { AnomalyLabRouteDeps } from "../routes/anomaly-lab.js";

const QUEUE_MAX = 100;

export async function listQueue(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  // Clamp to [1, QUEUE_MAX]; the Math.max(1, …) guards ?limit=-1/0/junk
  // (a negative limit would otherwise yield .limit(0) then crash on page[-1]).
  const rawLimit = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, QUEUE_MAX);
  // TODO(lab): createdAt-only keyset can skip/dup rows sharing a timestamp; for
  // tie-safety use a composite <iso>|<uuid> cursor (see handlers/admin-trace.ts).
  const cursor = c.req.query("cursor"); // ISO createdAt of the last item seen

  const conds = [eq(schema.stagedProducts.tenantId, tenantId), eq(schema.stagedProducts.status, "pending")];
  if (cursor) conds.push(gt(schema.stagedProducts.createdAt, new Date(cursor)));

  const rows = await deps.db
    .select({
      stagedProductId: schema.stagedProducts.stagedProductId,
      denormTitle: schema.stagedProducts.denormTitle,
      denormBrand: schema.stagedProducts.denormBrand,
      denormPrice: schema.stagedProducts.denormPrice,
      denormCurrency: schema.stagedProducts.denormCurrency,
      sourceKind: schema.stagedProducts.sourceKind,
      gateVerdict: schema.stagedProducts.gateVerdict,
      matchCandidates: schema.stagedProducts.matchCandidates,
      createdAt: schema.stagedProducts.createdAt,
    })
    .from(schema.stagedProducts)
    .where(and(...conds))
    .orderBy(asc(schema.stagedProducts.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null;

  const items = page.map((r) => {
    const verdict = (r.gateVerdict ?? {}) as { missingFields?: string[] };
    const candidates = (r.matchCandidates ?? []) as unknown[];
    return {
      stagedProductId: r.stagedProductId,
      denormTitle: r.denormTitle,
      denormBrand: r.denormBrand,
      denormPrice: r.denormPrice,
      denormCurrency: r.denormCurrency,
      sourceKind: r.sourceKind,
      missingFields: verdict.missingFields ?? [],
      candidateCount: candidates.length,
      createdAt: r.createdAt.toISOString(),
    };
  });
  // {data:...} envelope — the frontend request<> wrapper returns body.data and
  // throws on its absence (src/lib/api.ts). All lab endpoints must wrap.
  return c.json({ data: { items, nextCursor } });
}

export async function queueStats(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const rows = await deps.db
    .select({
      sourceKind: schema.stagedProducts.sourceKind,
      gateVerdict: schema.stagedProducts.gateVerdict,
      createdAt: schema.stagedProducts.createdAt,
    })
    .from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.tenantId, tenantId), eq(schema.stagedProducts.status, "pending")));

  const byReason: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byAge = { today: 0, week: 0, older: 0 };
  const now = Date.now();
  for (const r of rows) {
    bySource[r.sourceKind] = (bySource[r.sourceKind] ?? 0) + 1;
    for (const f of ((r.gateVerdict as { missingFields?: string[] })?.missingFields ?? [])) {
      byReason[f] = (byReason[f] ?? 0) + 1;
    }
    const ageDays = (now - r.createdAt.getTime()) / 86_400_000;
    if (ageDays < 1) byAge.today++;
    else if (ageDays < 7) byAge.week++;
    else byAge.older++;
  }
  return c.json({ data: { total: rows.length, byReason, bySource, byAge } });
}
