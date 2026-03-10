/**
 * Shared retry and backoff utilities
 * Eliminates duplication across client modules
 */

// ── Retry Constants ──

/** Base delay for exponential backoff (ms) */
export const RETRY_BASE_DELAY_MS = 1_000 as const;

/** Maximum backoff delay cap (ms) */
export const RETRY_MAX_DELAY_MS = 30_000 as const;

/** Jitter factor to prevent thundering herd */
export const JITTER_FACTOR = 0.3 as const;

/** Exponential base for backoff calculation */
export const EXPONENTIAL_BASE = 2 as const;

// ── HTTP Status Constants ──

/** HTTP status codes that indicate a retryable server error */
export const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504] as const;
export type RetryableStatusCode = typeof RETRYABLE_STATUS_CODES[number];

/** Network-level error codes that are retryable */
export const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'] as const;
export type NetworkErrorCode = typeof NETWORK_ERROR_CODES[number];

/** Timeout-related error message substrings */
export const TIMEOUT_ERROR_PATTERNS = ['timeout', 'timed out', 'deadline exceeded'] as const;

// ── Backoff Calculation ──

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: min(base * 2^attempt + random_jitter, maxDelay)
 *
 * @param attempt - Zero-based retry attempt number
 * @param baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param maxDelayMs - Maximum delay cap in milliseconds (default: 30000)
 * @returns Delay in milliseconds with jitter applied
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number = RETRY_BASE_DELAY_MS,
  maxDelayMs: number = RETRY_MAX_DELAY_MS,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(EXPONENTIAL_BASE, attempt);
  const jitter = JITTER_FACTOR * exponentialDelay * Math.random();
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Check if an HTTP status code is retryable
 */
export function isRetryableStatus(status: number): boolean {
  return (RETRYABLE_STATUS_CODES as readonly number[]).includes(status);
}

/**
 * Check if an error code indicates a network-level failure
 */
export function isNetworkError(code: string | undefined): boolean {
  if (!code) return false;
  return (NETWORK_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Check if an error message indicates a timeout
 */
export function isTimeoutError(message: string): boolean {
  const lower = message.toLowerCase();
  return TIMEOUT_ERROR_PATTERNS.some(pattern => lower.includes(pattern));
}
