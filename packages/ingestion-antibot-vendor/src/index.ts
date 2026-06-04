// Public barrel for @aonex/ingestion-antibot-vendor.
//
// Re-exports the ScrapingBee unblock adapter (unblockWithScrapingBee /
// createScrapingBeeAdapter) plus the per-request cost-ceiling guards
// (withinCostCeiling / creditsToUsd / COST_CONSTANTS) — the third-party
// anti-bot fetch tier of spec §6.4.

export {
  unblockWithScrapingBee,
  createScrapingBeeAdapter,
  type UnblockResult,
  type UnblockOptions,
  type ScrapingBeeClient
} from "./scrapingbee-adapter.js";
export {
  withinCostCeiling,
  creditsToUsd,
  COST_CONSTANTS
} from "./cost-ceiling.js";
