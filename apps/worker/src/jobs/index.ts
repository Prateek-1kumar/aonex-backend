// Cron job registry for the worker.
//
// Defines the JobContext / CronJob contract and exports CRON_JOBS, the array of
// scheduled rollup jobs. composition-root.ts iterates this to register each as a
// repeatable BullMQ job and dispatch its process(ctx) on schedule.

import type { DrizzleClient } from "@aonex/db";
import type { Logger } from "pino";
import type { ClassifierResolver } from "@aonex/taxonomy-classifier";
import { priceClusterRebuild } from "./price-cluster-rebuild.js";
import { overridePromotionScan } from "./override-promotion-scan.js";
import { failurePatternRollup } from "./failure-pattern-rollup.js";
import { domainProfileRefresh } from "./domain-profile-refresh.js";
import { schemaPromotionScan } from "./schema-promotion-scan.js";
import { canaryPoll } from "./canary-poll.js";
import { calibrationRefit } from "./calibration-refit.js";
import { driftScan } from "./drift-scan.js";
import { linkTraceCleanup } from "./link-trace-cleanup.js";
import { classifyUncategorized } from "./classify-uncategorized.js";

export interface JobContext {
  db: DrizzleClient;
  /** Structured logger; cron jobs log run summaries through this. */
  logger: Logger;
  /** Taxonomy resolver for the classify sweep. When an LLM provider is
   *  configured this is the LLM resolver (auto-assigns a best category so
   *  products aren't stuck uncategorized); otherwise the sweep falls back to the
   *  deterministic resolver. */
  classifierResolver?: ClassifierResolver;
}

export interface CronJob {
  /** Unique job name; used as the BullMQ job-id. */
  name: string;
  /** Cron expression in UTC. */
  cronSchedule: string;
  /** Job body. */
  process: (ctx: JobContext) => Promise<void>;
}

/**
 * Registered cron jobs. Individual job files import this and push themselves
 * onto the array as they're added in subsequent tasks (10-13).
 */
export const CRON_JOBS: CronJob[] = [priceClusterRebuild, overridePromotionScan, failurePatternRollup, domainProfileRefresh, schemaPromotionScan, canaryPoll, calibrationRefit, driftScan, linkTraceCleanup, classifyUncategorized];
