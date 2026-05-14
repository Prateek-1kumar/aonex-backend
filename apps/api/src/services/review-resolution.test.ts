import { describe, it } from "bun:test";

// NOTE: These tests require the project's test-DB harness. Until that's wired,
// the assertions remain placeholders. The shape of each `it()` documents the
// expected behavior so a follow-up can fill in the DB setup.

describe("editAndApprove", () => {
  it.todo("creates a mapping_override scoped to tenant+domain when canonicalPath changes");
  it.todo("creates an attribute_synonyms candidate when raw_key is renamed to a known canonical");
  it.todo("does NOT create an override when only the value (not the mapping) is changed");
});
