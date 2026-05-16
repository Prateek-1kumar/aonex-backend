import type { DrizzleClient } from "@aonex/db";
import { priceClusterRebuild } from "./price-cluster-rebuild.js";
import { overridePromotionScan } from "./override-promotion-scan.js";
import { failurePatternRollup } from "./failure-pattern-rollup.js";
import { domainProfileRefresh } from "./domain-profile-refresh.js";

export interface JobContext {
  db: DrizzleClient;
}

export interface CronJob {
  /** Unique job name; used as the BullMQ job-id. */
  name: string;
  /** Cron expression in UTC. */
  cronSchedule: string;
  /** Job body. */
  process: (ctx: JobContext) => Promise<void>;
}

// One-shot — not registered as a cron. Invoke via apps/worker/scripts/run-backfill.ts.
export { backfillAttributesJson } from "./backfill-attributes-json.js";

/**
 * Registered cron jobs. Individual job files import this and push themselves
 * onto the array as they're added in subsequent tasks (10-13).
 */
export const CRON_JOBS: CronJob[] = [priceClusterRebuild, overridePromotionScan, failurePatternRollup, domainProfileRefresh];
