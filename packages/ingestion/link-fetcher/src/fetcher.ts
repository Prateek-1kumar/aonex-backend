// Link fetcher — HTTP fetch with timeout, redirect handling, and
// content cleaning. HLD §11.4: "Fetcher, robots/compliance review,
// HTML snapshot storage, DOM provenance."
//
// Uses the native `fetch` API (available in Bun and Node 18+).
// No external HTTP client dependency needed.

import { sha256Hex } from "@aonex/lib-utils";
import { cleanHtml } from "./html-cleaner.js";
import {
  type LinkFetchOptions,
  type LinkFetchResult,
  LinkFetchError,
  DEFAULT_FETCH_OPTIONS,
} from "./types.js";

/**
 * Fetch a URL, validate the response, clean the HTML, and return
 * a structured result ready for source_artifact persistence.
 *
 * @throws {LinkFetchError} On network errors, timeouts, or invalid responses.
 */
export async function fetchLink(
  url: string,
  options?: LinkFetchOptions
): Promise<LinkFetchResult> {
  const opts = { ...DEFAULT_FETCH_OPTIONS, ...options };

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new LinkFetchError("Invalid URL", url);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new LinkFetchError(
      `Unsupported protocol: ${parsedUrl.protocol}`,
      url
    );
  }

  // Fetch with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": opts.userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: opts.followRedirects ? "follow" : "manual",
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Request timed out after ${opts.timeoutMs}ms`
        : `Network error: ${err instanceof Error ? err.message : String(err)}`;
    throw new LinkFetchError(message, url, undefined, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new LinkFetchError(
      `HTTP ${response.status}: ${response.statusText}`,
      url,
      response.status
    );
  }

  // Read body with size limit
  const rawHtml = await readBodyWithLimit(response, opts.maxBodyBytes, url);

  // Check content type
  const contentType = response.headers.get("content-type") ?? "unknown";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml") &&
    !contentType.includes("text/plain")
  ) {
    // Don't fail — some pages return unusual content types.
    // The LLM extractor will handle non-HTML gracefully.
  }

  const cleanedText = cleanHtml(rawHtml);
  const contentChecksum = sha256Hex(rawHtml);

  return {
    url,
    finalUrl: response.url || url,
    statusCode: response.status,
    contentType,
    rawHtml,
    cleanedText,
    fetchedAt: new Date(),
    contentChecksum,
  };
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  url: string
): Promise<string> {
  // Check Content-Length header first for early rejection
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new LinkFetchError(
      `Response too large: ${contentLength} bytes exceeds ${maxBytes} byte limit`,
      url,
      response.status
    );
  }

  const body = await response.text();

  if (body.length > maxBytes) {
    throw new LinkFetchError(
      `Response body too large: ${body.length} bytes exceeds ${maxBytes} byte limit`,
      url,
      response.status
    );
  }

  return body;
}
