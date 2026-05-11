// Exponential-backoff retry for transient failures on downstream service
// calls (sable-quant, sable-sandbox, EODHD, Stripe). Default policy: 3
// attempts with a 100ms base delay and full jitter, doubling each time.
//
// Only retry idempotent operations (GETs, well-known idempotent POSTs with
// an idempotency key). Use `shouldRetry` to filter — by default we retry
// network errors and 5xx responses, never 4xx.

export interface RetryOptions {
  /** Maximum number of attempts (including the first try). Default 3. */
  attempts?: number;
  /** Base delay in ms. Each retry doubles. Default 100. */
  baseMs?: number;
  /** Maximum delay between attempts. Default 2000. */
  maxMs?: number;
  /** Decide whether a given error is retryable. Default: network + 5xx. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Called before each retry; useful for structured logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 2_000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err, attempt)) throw err;
      const delay = jitter(Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws.
  throw lastErr;
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const code = (err as { code: string }).code;
    if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  }
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
  }
  return false;
}

function jitter(ms: number): number {
  return Math.floor(Math.random() * ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
