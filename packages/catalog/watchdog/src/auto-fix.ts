// Catalog redesign Phase 3.10 — auto-fix (spec §13.3, plan §3.10).
//
// "Discrepancy → emit alert + auto-fix (re-runs the reconciler for that
//  product)" — spec §13.3. Auto-fix is split out from drift-detector to
// keep the (read-only) detection function obviously side-effect-free.
//
// For sync-attribute drift: call projectSync per affected (attribute) leaf.
// projectSync owns the advisory lock + atomic update.
//
// For pricing/inventory drift: enqueue an async reconciler job. The async
// worker handles its own advisory locking + transaction. We do NOT block
// on completion — fire-and-forget; the watchdog returns the jobId so the
// caller can observe via stats.
//
// Alert emission: v1 emits `console.warn` per drift, matching identity-
// policy's pattern. Real paging integration (Phase 5 observability) will
// replace this with a proper alerting hook; the signature stays the same.
//
// Design decisions:
//   1. Queue is optional. If missing, async-fix is logged as deferred and
//      asyncEnqueued returns empty. Tests + dev environments without Redis
//      stay simple.
//   2. Per-product, per-attribute we enqueue once even if drift spans
//      multiple (channel, locale) leaves — the reconciler job recomputes
//      everything anyway.
//   3. The sync path runs projectSync with a synthesized rulesVersion=1
//      (matches the test-default everywhere in Phase 3). When the real
//      rules-versioning lands, callers will pass it via deps.
//   4. We catch and log per-product errors at the tier-runner level (not
//      here) — autoFixDrift will surface a thrown projectSync error so the
//      caller can log + continue.

import { Queue } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import {
  enqueueReconcilerJob,
  projectSync,
  type ReconcilerAttributeCode
} from "@aonex/catalog-service";
import type { DriftReport } from "./drift-detector.js";

// ---- Public types ----------------------------------------------------------

export interface AutoFixDeps {
  db: DrizzleClient;
  /** Optional — if omitted, async enqueues are skipped (logged + deferred). */
  queue?: Queue;
  /** Override the debounce for async-tier auto-fix. Default 0 (process ASAP
   *  since we already know drift exists). */
  debounceMs?: number;
  /** Override the rulesVersion stamped on projectSync's _meta. Default 1. */
  rulesVersion?: number;
}

export interface AutoFixResult {
  /** Attribute codes that were re-projected via projectSync. */
  syncProjected: string[];
  /** Async-tier enqueues. Each entry is one (attributeCode, jobId). */
  asyncEnqueued: Array<{ attributeCode: ReconcilerAttributeCode; jobId: string }>;
}

// ---- Public API ------------------------------------------------------------

/**
 * Apply auto-fix for the drift recorded in `report`:
 *   - Sync attributes → projectSync (in-band, transactional via the lock).
 *   - Pricing/inventory → enqueueReconcilerJob (debounced; we use 0ms so
 *     the worker picks it up immediately).
 *
 * Emits a `console.warn` per affected leaf — the v1 alert mechanism. A
 * real paging integration lands in Phase 5 observability.
 */
export async function autoFixDrift(
  deps: AutoFixDeps,
  productId: string,
  report: DriftReport
): Promise<AutoFixResult> {
  const { db, queue, debounceMs = 0, rulesVersion = 1 } = deps;

  // ---- Alert emission -----------------------------------------------------
  for (const d of report.driftAttributes) {
    console.warn(
      `[catalog-watchdog] DRIFT product=${productId} attr=${d.attributeCode} channel=${d.channel} locale=${d.locale} stored=${JSON.stringify(d.stored)} expected=${JSON.stringify(d.expected)}`
    );
  }
  for (const r of report.driftPricingCurrentRows) {
    console.warn(
      `[catalog-watchdog] DRIFT product=${productId} attr=pricing channel=${r.channelId} locale=${r.locale} stored=${JSON.stringify(r.stored)} expected=${JSON.stringify(r.expected)}`
    );
  }
  for (const r of report.driftInventoryCurrentRows) {
    console.warn(
      `[catalog-watchdog] DRIFT product=${productId} attr=inventory channel=${r.channelId} location=${r.locationIdCoalesced} stored=${JSON.stringify(r.stored)} expected=${JSON.stringify(r.expected)}`
    );
  }

  // ---- Sync auto-fix ------------------------------------------------------
  const syncAttrs = Array.from(
    new Set(report.driftAttributes.map((d) => d.attributeCode))
  );
  if (syncAttrs.length > 0) {
    await projectSync({
      db,
      productId,
      affectedAttributes: syncAttrs,
      rulesVersion
    });
  }

  // ---- Async auto-fix -----------------------------------------------------
  const asyncEnqueued: AutoFixResult["asyncEnqueued"] = [];
  const asyncAttrs: ReconcilerAttributeCode[] = [];
  if (report.driftPricingCurrentRows.length > 0) asyncAttrs.push("pricing");
  if (report.driftInventoryCurrentRows.length > 0) asyncAttrs.push("inventory");

  if (asyncAttrs.length === 0) {
    return { syncProjected: syncAttrs, asyncEnqueued };
  }

  if (!queue) {
    // No queue wired — log deferred and return cleanly. Tests + standalone
    // dev runs don't need Redis just to validate drift detection.
    console.warn(
      `[catalog-watchdog] DEFERRED-AUTOFIX product=${productId} attrs=${asyncAttrs.join(",")} reason=no_queue_in_deps`
    );
    return { syncProjected: syncAttrs, asyncEnqueued };
  }

  for (const attributeCode of asyncAttrs) {
    const job = await enqueueReconcilerJob(queue, {
      tenantId: report.tenantId,
      productId,
      attributeCode,
      debounceMs,
      rulesVersion
    });
    if (job.id) {
      asyncEnqueued.push({ attributeCode, jobId: job.id });
    }
  }
  return { syncProjected: syncAttrs, asyncEnqueued };
}
