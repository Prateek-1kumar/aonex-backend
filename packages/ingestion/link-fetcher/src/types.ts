// Link Fetcher types — pure data shapes, no side effects.

/** Options for fetching a URL. */
export interface LinkFetchOptions {
  /** Maximum time to wait for the HTTP response in ms. Default 15000. */
  timeoutMs?: number;
  /** Maximum HTML body size in bytes to accept. Default 5MB. */
  maxBodyBytes?: number;
  /** Custom User-Agent string. */
  userAgent?: string;
  /** Whether to follow redirects. Default true. */
  followRedirects?: boolean;
  /** Maximum number of redirects to follow. Default 5. */
  maxRedirects?: number;
}

/** Result of fetching and cleaning a URL. */
export interface LinkFetchResult {
  /** The original URL that was requested. */
  url: string;
  /** The final URL after any redirects. */
  finalUrl: string;
  /** HTTP status code from the final response. */
  statusCode: number;
  /** Content-Type header value. */
  contentType: string;
  /** Full raw HTML body. */
  rawHtml: string;
  /** Cleaned text with scripts/styles/nav stripped — ready for LLM. */
  cleanedText: string;
  /** Timestamp when the fetch completed. */
  fetchedAt: Date;
  /** SHA-256 hex digest of rawHtml — for source_artifact.checksum. */
  contentChecksum: string;
}

/** Errors specific to the link fetching process. */
export class LinkFetchError extends Error {
  public readonly url: string;
  public readonly statusCode?: number;

  constructor(
    message: string,
    url: string,
    statusCode?: number,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "LinkFetchError";
    this.url = url;
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
  }
}

export const DEFAULT_FETCH_OPTIONS: Required<LinkFetchOptions> = {
  timeoutMs: 15_000,
  maxBodyBytes: 500_000, // 500 KB
  userAgent: "AonexBot/1.0 (+https://aonex.io/bot)",
  followRedirects: true,
  maxRedirects: 5,
};

export interface StructuredBlocks {
  jsonLd: Record<string, unknown>[];
  nextData: Record<string, unknown> | null;
  apolloState: Record<string, unknown> | null;
  initialState: Record<string, unknown> | null;
}

export interface CleanResult {
  structuredBlocks: StructuredBlocks;
  cleanedText: string;
  captchaSignal: boolean;
}
