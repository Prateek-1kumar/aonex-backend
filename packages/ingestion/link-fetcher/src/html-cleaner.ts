import type { CleanResult, StructuredBlocks } from "./types.js";

const MAX_CLEANED_TEXT_LENGTH = 200_000;
const CAPTCHA_KEYWORDS = /captcha|robot check|are you human|access denied/i;
const CAPTCHA_SIZE_THRESHOLD = 10_000;

export function cleanHtml(rawHtml: string): CleanResult {
  const structuredBlocks = extractStructuredBlocks(rawHtml);
  const captchaSignal =
    rawHtml.length < CAPTCHA_SIZE_THRESHOLD && CAPTCHA_KEYWORDS.test(rawHtml);

  let text = rawHtml;

  // Remove script/style/svg/nav/footer
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, " $1 ");
  text = text.replace(
    /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    " $2 ($1) "
  );
  text = text.replace(
    /<\/?(div|p|br|h[1-6]|li|tr|td|th|section|article|main|aside|blockquote)[^>]*>/gi,
    "\n"
  );
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\t/g, " ");
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  text = truncateCenterPreserving(text, MAX_CLEANED_TEXT_LENGTH);

  return { structuredBlocks, cleanedText: text, captchaSignal };
}

function extractStructuredBlocks(html: string): StructuredBlocks {
  const jsonLd: Record<string, unknown>[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const parsed = JSON.parse(m[1]!.trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (isRecord(item)) jsonLd.push(item);
      } else if (isRecord(parsed)) {
        jsonLd.push(parsed);
      }
    } catch {
      /* malformed block — skip */
    }
  }

  const nextData = parseInlineScriptById(html, "__NEXT_DATA__");
  const apolloState = parseWindowAssignment(html, "__APOLLO_STATE__");
  const initialState = parseWindowAssignment(html, "__INITIAL_STATE__");

  return { jsonLd, nextData, apolloState, initialState };
}

function parseInlineScriptById(
  html: string,
  id: string
): Record<string, unknown> | null {
  const re = new RegExp(
    `<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!.trim());
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function parseWindowAssignment(
  html: string,
  name: string
): Record<string, unknown> | null {
  const re = new RegExp(
    `window\\.${name}\\s*=\\s*(\\{[\\s\\S]*?\\});?\\s*(?:<\\/script>|window\\.)`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function truncateCenterPreserving(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 30) / 2);
  return (
    text.substring(0, half) +
    "\n[...middle truncated]\n" +
    text.substring(text.length - half)
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
    "&lsquo;": "‘",
    "&rsquo;": "’",
    "&ldquo;": "“",
    "&rdquo;": "”",
    "&trade;": "™",
    "&reg;": "®",
    "&copy;": "©",
    "&times;": "×",
    "&divide;": "÷",
    "&euro;": "€",
    "&pound;": "£",
    "&yen;": "¥",
    "&cent;": "¢",
    "&hellip;": "…",
    "&bull;": "•",
  };
  let result = text;
  for (const [e, c] of Object.entries(entities)) result = result.replaceAll(e, c);
  result = result.replace(/&#(\d+);/g, (_, dec) =>
    String.fromCharCode(parseInt(dec, 10))
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return result;
}
