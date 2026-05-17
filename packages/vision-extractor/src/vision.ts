/**
 * Spec §6.6 — Vision tier-3 call against Groq llama-3.2-90b-vision-preview.
 *
 * Uses the OpenAI-compatible /v1/chat/completions endpoint with content
 * blocks (text + image_url). Direct fetch instead of going through
 * @aonex/ingestion-llm-extractor's OpenAIProvider because ChatMessage.content
 * is typed `string` there and doesn't accept multi-modal content arrays.
 *
 * Output: a fact set with the model's best-effort extraction. Conservative
 * confidence (0.70) because vision LLM is prone to hallucination on
 * low-resolution images.
 */

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export const VISION_EXTRACTOR_VERSION = "vision-groq-llama-3.2-90b@1.0";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "llama-3.2-90b-vision-preview";
const DEFAULT_TIMEOUT_MS = 30_000;
const VISION_CONFIDENCE = 0.70;

export interface VisionCallInput {
  /** PNG bytes base64-encoded (no data: URI prefix). */
  screenshotBase64: string;
  /** Page URL for context. */
  pageUrl: string;
  /** Optional list of known canonical fields the LLM should look for. */
  expectedFields?: string[];
}

export interface VisionCallResult {
  facts: ExtractedFact[];
  modelName: string;
  modelVersion: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export type VisionFetchImpl = typeof fetch;

export interface VisionCallDeps {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: VisionFetchImpl;
  timeoutMs?: number;
}

interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

const PRICING_PER_1M = { input: 0.90, output: 0.90 };    // Groq llama-3.2-90b-vision-preview

function estimateCost(promptTokens: number, completionTokens: number): number {
  return (promptTokens * PRICING_PER_1M.input + completionTokens * PRICING_PER_1M.output) / 1_000_000;
}

/**
 * Call the vision LLM. Returns extracted facts derived from the screenshot.
 *
 * Throws on network/auth error; parses gracefully when the model returns
 * malformed JSON (yields empty facts but still returns usage stats).
 */
export async function callVision(
  input: VisionCallInput,
  deps: VisionCallDeps
): Promise<VisionCallResult> {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const model = deps.model ?? DEFAULT_MODEL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const fields = (input.expectedFields ?? [
    "title", "brand", "base_price", "currency",
    "gtin", "model_number", "color", "size", "capacity"
  ]).join(", ");

  const systemPrompt = `You are a product catalog extractor. Look at the screenshot and extract ONLY fields you can clearly see. Return JSON with the keys you can extract. Do NOT invent values. If a field is not visible, OMIT it entirely.

Expected fields to look for: ${fields}.

Output JSON only. No prose.`;

  const userPrompt = `Page URL: ${input.pageUrl}\n\nExtract visible product fields from the screenshot. Output strict JSON.`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${input.screenshotBase64}` }
          }
        ]
      }
    ],
    max_tokens: 1024,
    temperature: 0.1,
    response_format: { type: "json_object" }
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vision API error ${response.status}: ${text.substring(0, 500)}`);
  }

  const parsed = (await response.json()) as GroqChatResponse;
  const content = parsed.choices?.[0]?.message?.content ?? "";
  const usage = parsed.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;

  let factObj: Record<string, unknown> = {};
  try {
    factObj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Malformed JSON — return empty facts. Usage still counted.
  }

  const facts: ExtractedFact[] = [];
  for (const [k, v] of Object.entries(factObj)) {
    if (v == null || v === "") continue;
    facts.push({
      rawKey: k,
      canonicalPath: null,
      extractedValue: v,
      normalizedValue: null,
      unit: null,
      sourcePointer: `vision:${k}`,
      extractionMethod: "inferred",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: VISION_CONFIDENCE,
      approved: false
    });
  }

  return {
    facts,
    modelName: parsed.model ?? model,
    modelVersion: VISION_EXTRACTOR_VERSION,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateCost(promptTokens, completionTokens)
  };
}
