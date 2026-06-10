// @aonex/taxonomy-schema — the canonical loaders around the taxonomy spine's
// per-leaf attribute schemas (node_attributes ⨝ attribute_definitions) and the
// winning_values read helpers. Pure transforms + thin DB wrappers, so the
// worker, the API and the eval/seed scripts all share one implementation.

export {
  NON_ATTR_KEYS,
  firstScoped,
  asText,
  flattenWinningAttrs,
} from "./winning-values.js";
export {
  buildLeafSchemaIndex,
  loadLeafSchemas,
  leafSchemaFor,
  type AttributeDefinitionLike,
  type NodeAttributeLike,
  type LeafSchemaIndex,
} from "./load-leaf-schemas.js";
export {
  toCatalogEntry,
  buildRagCorpus,
  loadRagCorpus,
  type CatalogProductLike,
} from "./rag-corpus.js";
