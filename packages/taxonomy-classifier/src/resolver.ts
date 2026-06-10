// Fallback resolvers. Two implementations of the same ClassifierResolver:
//   - deterministicResolver: NO LLM (dry-run) — weak-lexical-assign, else
//     propose a node under an inferred department, else abstain. Lets the whole
//     pipeline run + be tested offline.
//   - llmResolver(provider): wraps a chat provider (structurally compatible with
//     @aonex/ingestion-llm-extractor's IModelProvider) for the real path.

import { tokenize } from "./classify.js";
import type { ClassifierResolver, ResolverDecision, ResolverInput } from "./types.js";

/** Department inferred ONLY from an explicit signal-token match (no candidate
 *  fallback — a wrong-leaf candidate must not drag in its department). */
function inferDepartment(input: ResolverInput): { id: string; name: string } | null {
  const q = new Set([...tokenize(input.signals.title ?? ""), ...tokenize(input.signals.sourceCategory ?? "")]);
  for (const d of input.departments) {
    if (tokenize(d.name).some((t) => q.has(t))) return d;
  }
  return null;
}

const headName = (title: string | undefined): string => {
  const toks = (title ?? "").trim().split(/\s+/).filter(Boolean);
  return toks.slice(-2).join(" ") || "New Category";
};

/** Dry-run resolver — deterministic, no network. Deliberately NEVER assigns a
 *  mid-confidence guess (that's the LLM resolver's job); it proposes a node
 *  under an inferred department or abstains, so nothing is ever force-fit. */
export const deterministicResolver: ClassifierResolver = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async resolve(input: ResolverInput): Promise<ResolverDecision> {
    const dept = inferDepartment(input);
    if (dept) return { kind: "propose_node", parentId: dept.id, suggestedName: headName(input.signals.title), reason: `no leaf; inferred department ${dept.name}` };
    return { kind: "abstain", reason: "no confident match (needs LLM or human)" };
  },
};

// ── LLM resolver (real path; provider-pluggable) ──────────────────────────────

export interface ChatProvider {
  chatCompletion(params: {
    model: string;
    messages: { role: "system" | "user"; content: string }[];
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
  }): Promise<{ content: string }>;
}

const SYSTEM = `You are a product taxonomy classifier. Choose the single best category for the product.
- If one of the CANDIDATES fits, return {"decision":"assign","nodeId":"<id>"}.
- If none fit but a DEPARTMENT clearly does, return {"decision":"new_node","parentDepartment":"<id>","name":"<concise category name>"}.
- If nothing fits, return {"decision":"none"}.
Output STRICT JSON only.`;

function isolateJson(s: string): string {
  const t = s.trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  return i !== -1 && j > i ? t.slice(i, j + 1) : t;
}

/** Build a resolver backed by a chat provider (the real LLM fallback). */
export function llmResolver(provider: ChatProvider, model: string): ClassifierResolver {
  return {
    async resolve(input: ResolverInput): Promise<ResolverDecision> {
      const s = input.signals;
      const byDept = new Map<string, string[]>();
      for (const l of input.allLeaves) (byDept.get(l.departmentId) ?? byDept.set(l.departmentId, []).get(l.departmentId)!).push(`${l.nodeId}=${l.displayName}`);
      const catalog = input.departments.map((d) => `[${d.name}] ${(byDept.get(d.id) ?? []).join(", ")}`).join("\n");
      const user = [
        `PRODUCT: ${s.title ?? ""}${s.brand ? ` | brand: ${s.brand}` : ""}${s.sourceCategory ? ` | source: ${s.sourceCategory}` : ""}`,
        `Pick the single best leaf node_id from the CATALOG. If none fit, propose a new_node under the right department, else none.`,
        `CATALOG (node_id=name, by department):\n${catalog}`,
      ].join("\n\n");
      let parsed: { decision?: string; nodeId?: string; parentDepartment?: string; name?: string; reason?: string } = {};
      try {
        const res = await provider.chatCompletion({ model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 300, temperature: 0, jsonMode: true });
        parsed = JSON.parse(isolateJson(res.content));
      } catch {
        return { kind: "abstain", reason: "llm error" };
      }
      const valid = new Set(input.allLeaves.map((l) => l.nodeId));
      if (parsed.decision === "assign" && parsed.nodeId && valid.has(parsed.nodeId))
        return { kind: "assign", nodeId: parsed.nodeId, confidence: 0.85, ...(parsed.reason ? { reason: parsed.reason } : {}) };
      if (parsed.decision === "new_node" && parsed.parentDepartment && parsed.name)
        return { kind: "propose_node", parentId: parsed.parentDepartment, suggestedName: parsed.name, ...(parsed.reason ? { reason: parsed.reason } : {}) };
      return { kind: "abstain", ...(parsed.reason ? { reason: parsed.reason } : {}) };
    },
  };
}
