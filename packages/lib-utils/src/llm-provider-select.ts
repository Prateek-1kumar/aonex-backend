// Single source of truth for enrichment LLM selection, preferring Gemini, then
// Groq, then OpenAI (all OpenAI-compatible; Gemini via its compat endpoint).
// Pure: reads a bag of env strings (process.env fits structurally) and returns
// the resolved config, or null when no provider key is set.

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

const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

function geminiSelection(env: ProviderEnv): SelectedProvider | null {
  if (!env.GEMINI_API_KEY) return null;
  return {
    apiKey: env.GEMINI_API_KEY,
    baseUrl: env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE,
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
