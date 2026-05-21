// Shared internals for the new-catalog dual-path helpers.
//
// Kept in a single tiny module so the link and shopify path files share one
// definition instead of inventing the same magic UUID independently.

import type { ChannelId } from "@aonex/types";

/**
 * All-zeros UUID used as a placeholder `channelId` in adapter `AdaptContext`
 * when the channel row is unresolved. The link + shopify adapters do NOT
 * persist this id (the catalog-write layer maps `channelCode → channelId` at
 * side-table insert time). Side-table observations are stripped before the
 * write when this placeholder is in play, so it never leaks into storage.
 */
export const PLACEHOLDER_CHANNEL_ID =
  "00000000-0000-0000-0000-000000000000" as unknown as ChannelId;
