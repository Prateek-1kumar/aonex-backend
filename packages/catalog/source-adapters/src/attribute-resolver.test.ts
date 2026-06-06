import { describe, expect, test } from "bun:test";
import {
  buildVocabulary,
  isEmptyVocabulary,
  resolveAttributeCode,
  slugifyCustomKey,
} from "./attribute-resolver.js";
import type { AttributeDefinition, AttributeSynonym } from "./types.js";

function def(canonicalKey: string): AttributeDefinition {
  return { canonicalKey, canonicalUnit: null, dataType: "string", reconciliationPath: "sync" };
}
function syn(synonym: string, canonicalKey: string): AttributeSynonym {
  return { synonym, canonicalKey, sourceMarketplace: null };
}

describe("slugifyCustomKey", () => {
  test("normalises separators and case", () => {
    expect(slugifyCustomKey("search-alias")).toBe("search_alias");
    expect(slugifyCustomKey("Refresh Rate")).toBe("refresh_rate");
    expect(slugifyCustomKey("CPU Model (v2)")).toBe("cpu_model_v2");
    expect(slugifyCustomKey("rear_facing_camera")).toBe("rear_facing_camera");
  });
  test("falls back to 'unknown' for empty/garbage", () => {
    expect(slugifyCustomKey("")).toBe("unknown");
    expect(slugifyCustomKey("---")).toBe("unknown");
  });
});

describe("buildVocabulary / isEmptyVocabulary", () => {
  test("empty inputs yield an empty vocabulary", () => {
    const v = buildVocabulary([], []);
    expect(isEmptyVocabulary(v)).toBe(true);
  });
  test("non-empty definitions yield a non-empty vocabulary", () => {
    const v = buildVocabulary([def("color")], []);
    expect(isEmptyVocabulary(v)).toBe(false);
  });
  test("drops synonyms whose canonical target is not a known definition", () => {
    const v = buildVocabulary([def("ram")], [syn("memory", "ram"), syn("vendor", "brand")]);
    // "memory" → ram is kept (ram is a def); "vendor" → brand is dropped (no brand def).
    expect(resolveAttributeCode("memory", v).code).toBe("ram");
    expect(resolveAttributeCode("vendor", v).mapped).toBe(false);
  });
});

describe("resolveAttributeCode", () => {
  const vocab = buildVocabulary(
    [def("color"), def("ram"), def("description_long")],
    [syn("colour", "color")]
  );

  test("exact registry hit → canonical code, mapped", () => {
    const r = resolveAttributeCode("color", vocab);
    expect(r).toEqual({ code: "color", mapped: true, rawKey: "color" });
  });

  test("case-insensitive registry hit", () => {
    expect(resolveAttributeCode("RAM", vocab).code).toBe("ram");
    expect(resolveAttributeCode("RAM", vocab).mapped).toBe(true);
  });

  test("synonym hit → canonical code, mapped", () => {
    const r = resolveAttributeCode("Colour", vocab);
    expect(r.code).toBe("color");
    expect(r.mapped).toBe(true);
    expect(r.rawKey).toBe("Colour");
  });

  test("unrecognized key → custom.<slug>, unmapped, raw key preserved", () => {
    expect(resolveAttributeCode("search-alias", vocab)).toEqual({
      code: "custom.search_alias",
      mapped: false,
      rawKey: "search-alias",
    });
    expect(resolveAttributeCode("onlineday", vocab).code).toBe("custom.onlineday");
    expect(resolveAttributeCode("cpu_model", vocab).code).toBe("custom.cpu_model");
  });
});
