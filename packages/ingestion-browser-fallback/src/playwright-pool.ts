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
