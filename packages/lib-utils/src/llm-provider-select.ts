// Single source of truth for "which LLM powers enrichment?" — preferring
// Gemini, then Groq, then OpenAI. Both the worker enrichment path and the
// enrichment eval call this so the selection rule can't drift between them.
//
// Pure + dependency-free (lib-utils contract): takes a plain bag of env strings
// (process.env satisfies it structurally) and returns the resolved config, or
// null when no provider key is set. The returned shape feeds OpenAIProvider /
// createModelProvider directly — every provider here is OpenAI-compatible
// (Gemini via its OpenAI-compatibility endpoint).

export interface ProviderEnv {
  GEMINI_API_KEY?: string | undefined;
  GEMINI_BASE_URL?: string | undefined;
  GEMINI_MODEL_ENRICH?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  GROQ_BASE_URL?: string | undefined;
  GROQ_MODEL_ENRICH?: string | undefined;
  GROQ_MODEL_GAP_FILL?: string | undefined;
  GROQ_MODEL_FALLBACK?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_BASE_URL?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  // Index signature so process.env (NodeJS.ProcessEnv) is assignable directly;
  // the named fields above are for documentation + autocomplete.
  [key: string]: string | undefined;
}

export interface SelectedProvider {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Models to try when the primary is exhausted (Groq per-model TPD). */
  fallbackModels: string[];
  /** Which provider was chosen — for logging only. */
  provider: "gemini" | "groq" | "openai";
}

// Gemini's OpenAI-compatibility endpoint. The provider appends /chat/completions.
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

function geminiSelection(env: ProviderEnv): SelectedProvider | null {
  if (!env.GEMINI_API_KEY) return null;
  return {
    apiKey: env.GEMINI_API_KEY,
    baseUrl: env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE,
    // gemini-2.0-flash (not 2.5): no hidden "thinking" tokens, so the whole output
    // budget goes to the JSON answer (2.5-flash thinking truncates our structured
    // responses). Also higher free-tier limits + cheaper + faster.
    model: env.GEMINI_MODEL_ENRICH ?? "gemini-2.0-flash",
    fallbackModels: [],
    provider: "gemini",
  };
}
function groqSelection(env: ProviderEnv): SelectedProvider | null {
  if (!env.GROQ_API_KEY) return null;
  return {
    apiKey: env.GROQ_API_KEY,
    baseUrl: env.GROQ_BASE_URL ?? GROQ_DEFAULT_BASE,
    model: env.GROQ_MODEL_ENRICH ?? env.GROQ_MODEL_GAP_FILL ?? "llama-3.3-70b-versatile",
    // Groq enforces TPD PER MODEL; fall back to an independent-budget model.
    fallbackModels: [env.GROQ_MODEL_FALLBACK ?? "llama-3.1-8b-instant"],
    provider: "groq",
  };
}
function openaiSelection(env: ProviderEnv): SelectedProvider | null {
  if (!env.OPENAI_API_KEY) return null;
  return {
    apiKey: env.OPENAI_API_KEY,
    baseUrl: env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE,
    model: env.OPENAI_MODEL ?? "gpt-4o-mini",
    fallbackModels: [],
    provider: "openai",
  };
}

/**
 * The full ordered enrichment provider chain (Gemini → Groq → OpenAI), including
 * only those with a key set. Wrap these in a FallbackChatProvider for runtime
 * failover: when the primary 429s/errors, the request continues on the next.
 */
export function selectEnrichChain(env: ProviderEnv): SelectedProvider[] {
  return [geminiSelection(env), groqSelection(env), openaiSelection(env)].filter(
    (s): s is SelectedProvider => s !== null
  );
}

/**
 * The single preferred enrichment provider (chain head), or null when none is
 * configured. Use selectEnrichChain when you want runtime fallback.
 */
export function selectEnrichProvider(env: ProviderEnv): SelectedProvider | null {
  return selectEnrichChain(env)[0] ?? null;
}
