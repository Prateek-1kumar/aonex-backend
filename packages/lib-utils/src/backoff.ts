// HTTP-layer exponential backoff with full jitter for an adapter's own internal
// retries (BullMQ-level retries stay deterministic; see @aonex/types/retry).

export function backoffWithJitter(attempt: number, baseMs = 200, capMs = 30_000): number {
  const exp = Math.min(baseMs * Math.pow(2, attempt), capMs);
  return Math.floor(Math.random() * exp);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("AbortError"));
      },
      { once: true }
    );
  });
}
