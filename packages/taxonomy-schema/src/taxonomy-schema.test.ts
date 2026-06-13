import { describe, expect, test } from "bun:test";
import { buildLeafSchemaIndex } from "./load-leaf-schemas.js";
import { buildRagCorpus, toCatalogEntry } from "./rag-corpus.js";
import { firstScoped, asText, flattenWinningAttrs } from "./winning-values.js";

describe("winning-values", () => {
  test("firstScoped unwraps {channel:{locale:value}}", () => {
    expect(firstScoped({ csv: { _unscoped: "Slim Jeans" } })).toBe("Slim Jeans");
    expect(firstScoped("already plain")).toBe("already plain");
    expect(firstScoped(null)).toBeNull();
  });

  test("asText joins arrays as breadcrumb", () => {
    expect(asText(["Apparel", "Jeans"])).toBe("Apparel > Jeans");
    expect(asText(null)).toBe("");
  });

  test("flattenWinningAttrs drops non-attribute keys and empties", () => {
    const attrs = flattenWinningAttrs({
      title: { csv: { _unscoped: "x" } },
      images: { csv: { _unscoped: ["u"] } },
      fit: { csv: { _unscoped: "slim" } },
      material: { csv: { _unscoped: "" } },
    });
    expect(attrs).toEqual({ fit: "slim" });
  });
});

describe("buildLeafSchemaIndex", () => {
  const ads = [
    { canonicalKey: "fit", label: "Fit", dataType: "string", enumValues: ["slim", "regular"] },
    { canonicalKey: "weight", dataType: "number", canonicalUnit: "g", allowedUnits: ["g", "kg"] },
  ];
  const nas = [
    { nodeId: "fashion/jeans", canonicalKey: "fit", tier: "required", isVariantAxis: true },
    { nodeId: "fashion/jeans", canonicalKey: "weight", tier: "optional" },
    { nodeId: "fashion/jeans", canonicalKey: "undefined_attr", tier: "optional" },
  ];

  test("joins definitions onto node attributes (+ merges the universal content layer)", () => {
    const { schemaByNode } = buildLeafSchemaIndex(nas, ads);
    const fields = schemaByNode.get("fashion/jeans")!;
    const specs = fields.filter((f) => f.kind === "spec");
    const content = fields.filter((f) => f.kind === "content");

    // The 3 node spec attributes, tagged kind:"spec".
    expect(specs).toHaveLength(3);
    expect(specs[0]).toEqual({
      key: "fit",
      tier: "required",
      kind: "spec",
      label: "Fit",
      dataType: "string",
      enumValues: ["slim", "regular"],
      isVariantAxis: true,
    });
    expect(specs[1]).toEqual({ key: "weight", tier: "optional", kind: "spec", dataType: "number", unit: "g", allowedUnits: ["g", "kg"] });
    // An attribute with no definition row still appears (key + tier + kind).
    expect(specs[2]).toEqual({ key: "undefined_attr", tier: "optional", kind: "spec" });

    // The universal content layer is merged into every leaf with a spec schema.
    expect(content.length).toBeGreaterThan(0);
    expect(content.find((f) => f.key === "meta_title")).toMatchObject({ kind: "content", contentType: "text", group: "seo" });
    expect(content.find((f) => f.key === "seo_keywords")).toMatchObject({ kind: "content", contentType: "string_list" });
  });

  test("indexes display paths", () => {
    const { pathByNode } = buildLeafSchemaIndex([], [], [
      { nodeId: "fashion/jeans", displayPath: "Fashion › Jeans" },
      { nodeId: "draft", displayPath: null },
    ]);
    expect(pathByNode.get("fashion/jeans")).toBe("Fashion › Jeans");
    expect(pathByNode.has("draft")).toBe(false);
  });
});

describe("rag corpus", () => {
  test("toCatalogEntry maps a product row", () => {
    const entry = toCatalogEntry({
      winningValues: {
        title: { csv: { _unscoped: "Acme Slim Jeans" } },
        fit: { csv: { _unscoped: "slim" } },
      },
      identity: { brand: "Acme" },
      categoryNodeId: "fashion/clothing/jeans",
    });
    expect(entry).toEqual({
      title: "Acme Slim Jeans",
      brand: "Acme",
      nodeId: "fashion/clothing/jeans",
      departmentId: "fashion",
      attrs: { fit: "slim" },
    });
  });

  test("buildRagCorpus skips titleless products", () => {
    expect(buildRagCorpus([{ winningValues: {} }])).toEqual([]);
  });
});
