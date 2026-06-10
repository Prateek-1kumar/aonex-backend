// Per-leaf enrichment schema: node_attributes ⨝ attribute_definitions →
// EnrichField[] per taxonomy node, plus the display-path lookup.
//
// This was duplicated three times (classify-catalog, run-taxonomy-eval,
// run-enrichment-eval) with drifting feature sets; this is the canonical
// loader. The join is a pure transform (buildLeafSchemaIndex) so it can be
// unit-tested without a database; loadLeafSchemas is the thin DB wrapper.

import { schema, type DrizzleClient } from "@aonex/db";
import { toLeafSchema, type AttrDataType, type EnrichField } from "@aonex/taxonomy-enrichment";
import type { LeafSchema } from "@aonex/taxonomy-validator";

/** The attribute_definitions columns the schema join reads (structural, so
 *  tests can pass plain objects instead of Drizzle rows). */
export interface AttributeDefinitionLike {
  canonicalKey: string;
  label?: string | null;
  description?: string | null;
  dataType?: string | null;
  enumValues?: string[] | null;
  canonicalUnit?: string | null;
  allowedUnits?: string[] | null;
  enrichmentGroup?: string | null;
}

/** The node_attributes columns the schema join reads. */
export interface NodeAttributeLike {
  nodeId: string;
  canonicalKey: string;
  tier: string;
  isVariantAxis?: boolean | null;
}

export interface LeafSchemaIndex {
  /** nodeId -> prompt-ready enrichment fields. */
  schemaByNode: Map<string, EnrichField[]>;
  /** nodeId -> display breadcrumb ("Fashion › Clothing › Jeans"). */
  pathByNode: Map<string, string>;
  /** canonicalKey -> attribute_definitions.enrichment_group (UI badge group). */
  groupByKey: Map<string, string>;
}

const mapType = (t: string | null | undefined): AttrDataType | undefined =>
  t === "string" || t === "number" || t === "boolean" || t === "array" ? t : undefined;

/** Join node_attributes to attribute_definitions into per-node EnrichField lists. */
export function buildLeafSchemaIndex(
  nodeAttributes: NodeAttributeLike[],
  attributeDefinitions: AttributeDefinitionLike[],
  nodes: { nodeId: string; displayPath: string | null }[] = []
): LeafSchemaIndex {
  const adByKey = new Map(attributeDefinitions.map((a) => [a.canonicalKey, a]));
  const schemaByNode = new Map<string, EnrichField[]>();
  for (const na of nodeAttributes) {
    const ad = adByKey.get(na.canonicalKey);
    const f: EnrichField = { key: na.canonicalKey, tier: na.tier as EnrichField["tier"] };
    if (ad?.label) f.label = ad.label;
    if (ad?.description) f.description = ad.description;
    const dt = mapType(ad?.dataType);
    if (dt) f.dataType = dt;
    if (ad?.enumValues?.length) f.enumValues = ad.enumValues;
    if (ad?.canonicalUnit) {
      f.unit = ad.canonicalUnit;
      if (ad.allowedUnits?.length) f.allowedUnits = ad.allowedUnits;
    }
    if (na.isVariantAxis) f.isVariantAxis = true;
    let fields = schemaByNode.get(na.nodeId);
    if (!fields) schemaByNode.set(na.nodeId, (fields = []));
    fields.push(f);
  }
  const pathByNode = new Map(nodes.filter((n) => n.displayPath != null).map((n) => [n.nodeId, n.displayPath!]));
  const groupByKey = new Map(
    attributeDefinitions
      .filter((a) => a.enrichmentGroup != null)
      .map((a) => [a.canonicalKey, a.enrichmentGroup!])
  );
  return { schemaByNode, pathByNode, groupByKey };
}

/** Load the full per-leaf schema index from the database. */
export async function loadLeafSchemas(db: DrizzleClient): Promise<LeafSchemaIndex> {
  const [attrDefs, nodeAttrs, nodes] = await Promise.all([
    db.select().from(schema.attributeDefinitions),
    db.select().from(schema.nodeAttributes),
    db.select().from(schema.taxonomyNodes),
  ]);
  return buildLeafSchemaIndex(nodeAttrs, attrDefs, nodes);
}

/** The validator-facing LeafSchema for one node, or null when the node has no
 *  attribute schema. */
export function leafSchemaFor(index: LeafSchemaIndex, nodeId: string): LeafSchema | null {
  const fields = index.schemaByNode.get(nodeId);
  return fields ? toLeafSchema(nodeId, fields) : null;
}
