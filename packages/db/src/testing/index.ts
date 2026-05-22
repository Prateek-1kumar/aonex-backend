// Public barrel for the @aonex/db/testing subpath export.
// Other workspace packages that run integration tests against the real
// dev DB import these helpers — see `packages/catalog/catalog-service`
// tests for an example consumer.

export { connectTestDb, closeTestDb } from "./connect.js";
export { ensureTestTenant, TEST_TENANT_ID } from "./seed-tenant.js";
export { ensureTestMerchant, TEST_MERCHANT_ID } from "./seed-merchant.js";
export { ensureTestChannel, TEST_CHANNEL_ID } from "./seed-channel.js";
export {
  ensureTestInventoryLocation,
  TEST_LOCATION_ID
} from "./seed-inventory-location.js";
