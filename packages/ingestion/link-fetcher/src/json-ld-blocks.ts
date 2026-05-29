/** Flatten arbitrary JSON-LD into a flat list of typed nodes: unwrap top-level
 *  arrays and `@graph` containers so downstream parsers can find Product nodes
 *  regardless of nesting. `@type` is left as-is (string or array). */
export function flattenJsonLdNodes(parsed: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (Array.isArray(o["@graph"])) (o["@graph"] as unknown[]).forEach(visit);
      out.push(o);
    }
  };
  visit(parsed);
  return out;
}
