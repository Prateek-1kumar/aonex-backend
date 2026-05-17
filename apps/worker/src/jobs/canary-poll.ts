// apps/worker/src/jobs/canary-poll.ts
// Phase 7 — hourly cron that samples a few URLs from each per-site parser's
// canary list and verifies the parser still extracts the expected fields.
// Selector drift on real retailer pages shows up here within an hour.

import type { CronJob } from "./index.js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchLink, type LinkFetchResult } from "@aonex/ingestion-link-fetcher";
import { findParserForUrl, type PerSiteParser } from "@aonex/per-site-parsers";

/**
 * Fixtures dir is co-located with the per-site-parsers package source. In dev
 * the worker reads it via the workspace's symlinked path; in production the
 * canary-urls.json files are bundled alongside the package on disk via the
 * monorepo build. If the dir is missing at runtime the cron is a no-op.
 */
const DEFAULT_FIXTURES_DIR = resolve(
  process.cwd(),
  "packages/per-site-parsers/src/fixtures"
);

const URLS_PER_CRON_RUN = 5;
const FETCH_TIMEOUT_MS = 10_000;

export interface CanaryRetailerResult {
  retailer: string;
  domain: string;
  total: number;
  sampled: number;
  passed: number;
  failed: Array<{ url: string; reason: string }>;
}

export interface CanaryPollResult {
  retailers: CanaryRetailerResult[];
  overallPassRate: number;
}

export interface CanaryPollDeps {
  fixturesDir?: string;
  fetcher?: typeof fetchLink;
  findParser?: (url: string) => PerSiteParser | null;
}

/** Pure runner — testable without BullMQ. */
export async function runCanaryPoll(deps: CanaryPollDeps = {}): Promise<CanaryPollResult> {
  const fixturesDir = deps.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const fetcher = deps.fetcher ?? fetchLink;
  const findParser = deps.findParser ?? findParserForUrl;

  if (!existsSync(fixturesDir) || !statSync(fixturesDir).isDirectory()) {
    return { retailers: [], overallPassRate: 1.0 };
  }

  const retailers: CanaryRetailerResult[] = [];

  for (const retailer of readdirSync(fixturesDir)) {
    const canaryFile = join(fixturesDir, retailer, "canary-urls.json");
    if (!existsSync(canaryFile)) continue;

    let config: { domain: string; urls: string[]; expectedFields: string[] };
    try {
      config = JSON.parse(readFileSync(canaryFile, "utf-8"));
    } catch {
      continue; // malformed file — skip
    }

    const result: CanaryRetailerResult = {
      retailer,
      domain: config.domain,
      total: config.urls.length,
      sampled: 0,
      passed: 0,
      failed: []
    };

    const sample = config.urls.slice(0, URLS_PER_CRON_RUN);
    for (const url of sample) {
      result.sampled++;
      try {
        const fetched: LinkFetchResult = await fetcher(url, { timeoutMs: FETCH_TIMEOUT_MS });
        const parser = findParser(fetched.finalUrl);
        if (!parser) {
          result.failed.push({ url, reason: "no_parser_matched" });
          continue;
        }
        const facts = await parser.extract({ rawHtml: fetched.rawHtml, url: fetched.finalUrl });
        const missing = config.expectedFields.filter(
          (f) => !facts.find((x: { rawKey: string }) => x.rawKey === f)
        );
        if (missing.length === 0) result.passed++;
        else result.failed.push({ url, reason: `missing_fields:${missing.join(",")}` });
      } catch (err) {
        result.failed.push({
          url,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }

    retailers.push(result);
  }

  const totalSampled = retailers.reduce((sum, r) => sum + r.sampled, 0);
  const totalPassed = retailers.reduce((sum, r) => sum + r.passed, 0);
  const overallPassRate = totalSampled === 0 ? 1.0 : totalPassed / totalSampled;

  return { retailers, overallPassRate };
}

/**
 * CronJob registration. Hourly at minute 0. Doesn't use ctx.db today —
 * Phase 8 dashboards will consume the canary results via audit emission
 * (deferred — AuditEventInput.tenantId is required and we have no real
 * tenant for a system cron yet).
 */
export const canaryPoll: CronJob = {
  name: "canary-poll",
  cronSchedule: "0 * * * *",
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async process(_ctx) {
    const result = await runCanaryPoll();
    // BullMQ's worker.on("completed") in composition-root logs the returned
    // value via pino, so just logging via console here would duplicate.
    // Return is implicit (void per CronJob.process signature) — but we
    // attach the summary to a global console.info so it shows up in
    // worker logs even before Phase 8 dashboards.
    // eslint-disable-next-line no-console
    console.info("[canary-poll]", JSON.stringify({
      retailerCount: result.retailers.length,
      overallPassRate: result.overallPassRate,
      perRetailer: result.retailers.map((r) => ({
        retailer: r.retailer,
        passed: r.passed,
        sampled: r.sampled,
        failedCount: r.failed.length
      }))
    }));
  }
};
