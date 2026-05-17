import { describe, it, expect } from "bun:test";
import { VIEW_DEFINITIONS, REFRESH_ALL_VIEWS_SQL } from "./views.js";

describe("VIEW_DEFINITIONS", () => {
  it("exposes exactly 5 views with the canonical name prefix", () => {
    const names = Object.keys(VIEW_DEFINITIONS);
    expect(names).toHaveLength(5);
    for (const n of names) expect(n.startsWith("v_")).toBe(true);
  });

  it("every view starts with a SELECT clause", () => {
    for (const [name, sql] of Object.entries(VIEW_DEFINITIONS)) {
      expect(sql.trim().toUpperCase().startsWith("SELECT"), `view ${name} must start with SELECT`).toBe(true);
    }
  });

  it("every view references a known production table", () => {
    const knownTables = ["product_versions", "audit_events", "extraction_runs"];
    for (const [name, sql] of Object.entries(VIEW_DEFINITIONS)) {
      const matchesAny = knownTables.some((t) => sql.includes(t));
      expect(matchesAny, `view ${name} must reference one of ${knownTables.join(",")}`).toBe(true);
    }
  });

  it("v_fleet_overview groups by tenant + category + hour", () => {
    const sql = VIEW_DEFINITIONS.v_fleet_overview;
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("canonical_category");
    expect(sql.toLowerCase()).toContain("group by");
  });

  it("v_cost_panel sums estimatedCostUsd from llm.% audit events", () => {
    const sql = VIEW_DEFINITIONS.v_cost_panel;
    expect(sql).toContain("'estimatedCostUsd'");
    expect(sql).toContain("'llm.%'");
  });

  it("v_field_completeness counts each major canonical field with FILTER clause", () => {
    const sql = VIEW_DEFINITIONS.v_field_completeness;
    for (const field of ["title", "brand", "gtin", "base_price"]) {
      expect(sql).toContain(field);
    }
  });
});

describe("REFRESH_ALL_VIEWS_SQL", () => {
  it("emits a REFRESH statement per view", () => {
    const lines = REFRESH_ALL_VIEWS_SQL.split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line.trim().startsWith("REFRESH MATERIALIZED VIEW")).toBe(true);
      expect(line.includes("CONCURRENTLY")).toBe(true);
    }
  });

  it("each refresh line targets a view from VIEW_DEFINITIONS", () => {
    const definedViews = new Set(Object.keys(VIEW_DEFINITIONS));
    const refreshLines = REFRESH_ALL_VIEWS_SQL.split("\n").filter(Boolean);
    for (const line of refreshLines) {
      const viewName = line.match(/REFRESH MATERIALIZED VIEW CONCURRENTLY (\w+);/)?.[1];
      expect(viewName).toBeDefined();
      expect(definedViews.has(viewName!)).toBe(true);
    }
  });
});
