import { describe, it } from "bun:test";

// NOTE: These tests require the project's test-DB harness. Until that's wired,
// the assertions remain placeholders. The shape of each `it()` documents the
// expected behavior so a follow-up can fill in the DB setup.

describe("editAndApprove", () => {
  it.todo("creates a mapping_override scoped to tenant+domain when canonicalPath changes");
  it.todo("creates an attribute_synonyms candidate when raw_key is renamed to a known canonical");
  it.todo("does NOT create an override when only the value (not the mapping) is changed");
});

describe("rejectTask", () => {
  it.todo("inserts a new extraction_failures row when none exists for (tenant, domain, reason)");
  it.todo("increments occurrence_count when a matching extraction_failures row already exists");
  it.todo("flips proposed_diff.status to rejected and review_task.status to resolved");
});

describe("mergeWithExisting", () => {
  it.todo("inserts a product_identities row with identityType='url'");
  it.todo("is idempotent: re-merging the same URL into the same product is a no-op");
  it.todo("flips proposed_diff.status to rejected (merge = no new product_version)");
});
