// HTML cleaning — strips irrelevant content and extracts the main
// textual content suitable for LLM consumption.
//
// Design: intentionally simple regex/string-based approach.
// We avoid heavy DOM parsers (cheerio/jsdom) to keep the package
// lightweight. If more precision is needed later, swap this module
// without changing the interface.

/** Maximum characters of cleaned text to send to the LLM. */
const MAX_CLEANED_TEXT_LENGTH = 50_000;

/**
 * Remove HTML elements that add noise but no product information.
 * Returns a cleaned text string ready for LLM extraction.
 */
export function cleanHtml(rawHtml: string): string {
  let text = rawHtml;

  // 1. Remove script and style tags and their content
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // 2. Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // 3. Remove SVG blocks (icons, decorative graphics)
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  // 4. Remove common navigation/footer/header/sidebar patterns
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");

  // 5. Extract alt text from images before stripping tags
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, " $1 ");

  // 6. Preserve href values from links (may contain product URLs)
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, " $2 ($1) ");

  // 7. Convert common block elements to newlines for readability
  text = text.replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|section|article|main|aside|blockquote)[^>]*>/gi, "\n");

  // 8. Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // 9. Decode common HTML entities
  text = decodeHtmlEntities(text);

  // 10. Normalize whitespace
  text = text.replace(/\t/g, " ");
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // 11. Truncate to max length for LLM context window
  if (text.length > MAX_CLEANED_TEXT_LENGTH) {
    text = text.substring(0, MAX_CLEANED_TEXT_LENGTH) + "\n[...truncated]";
  }

  return text;
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
    "&lsquo;": "'",
    "&rsquo;": "'",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
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
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replaceAll(entity, char);
  }

  // Decode numeric entities (&#123; and &#x1A;)
  result = result.replace(/&#(\d+);/g, (_, dec) =>
    String.fromCharCode(parseInt(dec, 10))
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );

  return result;
}
