import { chromium, type Browser, type Page } from "playwright";

export interface FetchBrowserResult {
  rawHtml: string;
  finalUrl: string;
  statusCode: number;
  fetchDurationMs: number;
}

export interface FetchBrowserOptions {
  waitForSelector?: string;
  timeoutMs?: number;
  blockResources?: boolean;
}

let sharedBrowser: Browser | null = null;
let activeContexts = 0;

const MAX_CONCURRENT = Number(process.env["PLAYWRIGHT_POOL_SIZE"] ?? "10");
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
    });
  }
  return sharedBrowser;
}

async function acquireSlot(): Promise<void> {
  while (activeContexts >= MAX_CONCURRENT) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  activeContexts++;
}

function releaseSlot(): void {
  activeContexts = Math.max(0, activeContexts - 1);
}

/**
 * Spec §6.3 — render the URL through headless Chromium and return final HTML
 * + status. Uses a shared Browser process with per-call BrowserContext for
 * isolation; resource-blocks images/css/fonts for speed unless disabled.
 */
export async function fetchWithBrowser(
  url: string,
  opts?: FetchBrowserOptions
): Promise<FetchBrowserResult> {
  await acquireSlot();
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 }
  });
  const page: Page = await context.newPage();

  if (opts?.blockResources !== false) {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "stylesheet" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });
  }

  const start = Date.now();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
    if (opts?.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 5_000 }).catch(() => undefined);
    }
    const rawHtml = await page.content();
    return {
      rawHtml,
      finalUrl: page.url(),
      statusCode: response?.status() ?? 0,
      fetchDurationMs: Date.now() - start
    };
  } finally {
    await context.close();
    releaseSlot();
  }
}

export interface FetchBrowserWithScreenshotOptions {
  waitForSelector?: string;
  timeoutMs?: number;
  blockResources?: boolean;
  /** CSS selector to scope the screenshot. When omitted, full viewport. */
  screenshotSelector?: string;
  /** Capture full page (scroll) or just viewport. Default false (viewport only). */
  fullPage?: boolean;
}

export interface FetchBrowserWithScreenshotResult extends FetchBrowserResult {
  /** PNG bytes, base64-encoded for transport to vision LLM. */
  screenshotBase64: string;
}

/**
 * Spec §6.6 — fetch a URL through headless Chromium AND capture a PNG
 * screenshot of the rendered page (or a selector-scoped subregion).
 * The Phase 9 vision extractor passes the screenshot to a multimodal
 * LLM (Groq Llama 3.2 90B Vision) when text-extraction failed to find
 * image-rendered specs (apparel size charts, electronics spec graphics,
 * image-rendered prices).
 *
 * Shares the same browser pool + semaphore as fetchWithBrowser. Selector-
 * scoped screenshots are best-effort: when the selector is missing, falls
 * back to a full-viewport capture.
 *
 * NOTE: blockResources defaults to false here (unlike fetchWithBrowser which
 * defaults to true) because vision fidelity requires images + CSS to be
 * loaded. Only font/media are blocked when blockResources=true is explicitly
 * passed. Selector-scoped screenshot falls back to full-viewport if the
 * selector is missing (best-effort).
 */
export async function fetchWithBrowserAndScreenshot(
  url: string,
  opts?: FetchBrowserWithScreenshotOptions
): Promise<FetchBrowserWithScreenshotResult> {
  await acquireSlot();
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 }
  });
  const page: Page = await context.newPage();

  // For screenshot fidelity we typically WANT images + CSS; only block them
  // when the caller opts in explicitly to save time.
  if (opts?.blockResources === true) {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "font" || t === "media") return route.abort();
      return route.continue();
    });
  }

  const start = Date.now();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
    if (opts?.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 5_000 }).catch(() => undefined);
    }
    const rawHtml = await page.content();

    let screenshotBuffer: Buffer;
    if (opts?.screenshotSelector) {
      const handle = await page.$(opts.screenshotSelector);
      if (handle) {
        screenshotBuffer = await handle.screenshot({ type: "png" });
      } else {
        // Selector missing — fall back to viewport screenshot
        screenshotBuffer = await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
      }
    } else {
      screenshotBuffer = await page.screenshot({ type: "png", fullPage: opts?.fullPage ?? false });
    }

    return {
      rawHtml,
      finalUrl: page.url(),
      statusCode: response?.status() ?? 0,
      fetchDurationMs: Date.now() - start,
      screenshotBase64: screenshotBuffer.toString("base64")
    };
  } finally {
    await context.close();
    releaseSlot();
  }
}

/**
 * Closes the shared browser. Call from worker shutdown hook.
 */
export async function closeBrowserPool(): Promise<void> {
  if (sharedBrowser) {
    const b = sharedBrowser;
    sharedBrowser = null;
    await b.close();
  }
}
