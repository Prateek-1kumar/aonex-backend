// HTTP-layer backoff with full jitter. BullMQ-level retries stay
// deterministic (see @aonex/types/retry); this helper is for the
// adapter's own internal retries to avoid thundering herd.
//
// Reference: AWS "Exponential Backoff and Jitter" — full jitter
// is `random_between(0, base * 2^attempt)`.

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
