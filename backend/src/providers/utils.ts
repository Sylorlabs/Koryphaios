import { providerLog } from "../logger";

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  jitterFactor?: number;
  shouldRetry?: (error: any) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 8,
  initialDelayMs: 2000,
  jitterFactor: 0.2,
  shouldRetry: (error: any) => {
    // Check for standard fetch errors or provider-specific error objects
    const status = error?.status ?? error?.statusCode ?? error?.response?.status;
    const message = (error?.message || "").toLowerCase();

    // 429: Too Many Requests (Rate Limit)
    // 500: Internal Server Error
    // 502: Bad Gateway
    // 503: Service Unavailable
    // 504: Gateway Timeout
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }

    // Check message content for rate limit indicators if status is missing
    if (message.includes("rate limit") || message.includes("quota") || message.includes("429")) {
      return true;
    }

    return false;
  }
};

/**
 * Execute an async operation with exponential backoff and jitter.
 * Ported from OpenCode's robust retry logic.
 */
export async function withRetry<T>(
  operation: () => T | Promise<T>,
  options: RetryOptions = {}
): Promise<Awaited<T>> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      if (attempt === opts.maxRetries || !opts.shouldRetry(error)) {
        throw error;
      }

      // Check for Retry-After header (standard in HTTP 429)
      let retryAfterMs = 0;
      const headers = error?.response?.headers ?? error?.headers;
      if (headers) {
        // Handle both Map-like and object-like headers
        const retryHeader = typeof headers.get === 'function'
          ? headers.get("retry-after")
          : headers["retry-after"];

        if (retryHeader) {
          const seconds = parseInt(retryHeader, 10);
          if (!isNaN(seconds)) {
            retryAfterMs = seconds * 1000;
          }
        }
      }

      // Calculate backoff
      // 2000 * (2 ^ (attempt - 1))
      let backoffMs = opts.initialDelayMs * Math.pow(2, attempt - 1);

      // Add jitter: +/- 20% of backoff
      // OpenCode uses +jitter, we'll do the same
      const jitterMs = backoffMs * opts.jitterFactor * Math.random();
      let delayMs = backoffMs + jitterMs;

      // If Retry-After was specified and is larger, use that
      if (retryAfterMs > delayMs) {
        delayMs = retryAfterMs;
      }

      providerLog.warn(
        {
          attempt,
          maxRetries: opts.maxRetries,
          delayMs: Math.round(delayMs),
          error: error.message
        },
        "Retrying operation due to error"
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
