'use strict';

/**
 * Bounded retry for clearly-transient provider operations (Issue #8).
 *
 * Narrow by design: an operation is retried only when its boundary has
 * classified the failure as BOTH transient and duplication-safe. The
 * classification happens at the provider boundary (the operation throws a
 * taxonomy-categorized error with `retryable`); this helper only supplies
 * bounded attempts, short deterministic backoff, and telemetry events.
 * There are no unbounded loops and no hidden sleeps in tests — the sleep
 * function is injected.
 */

/**
 * @param {() => Promise<any>} operation throws taxonomy-categorized errors
 * @param {{
 *   attempts?: number,                    total tries including the first
 *   backoffMs?: number[],                 delay before retry N (clamped to last)
 *   sleep?: (ms: number) => Promise<void>,
 *   onEvent?: (name: 'retry.attempted'|'retry.exhausted', fields: object) => void,
 *   fields?: object,                      safe telemetry fields for events
 * }} [options]
 */
async function withRetry(operation, {
  attempts = 3,
  backoffMs = [100, 400],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onEvent = () => {},
  fields = {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const retryable = err && err.retryable === true;
      if (!retryable || attempt === attempts) {
        if (retryable) {
          onEvent('retry.exhausted', {
            ...fields,
            attempt,
            maxAttempts: attempts,
            category: err.category,
            severity: 'error',
          });
        }
        throw err;
      }
      onEvent('retry.attempted', {
        ...fields,
        attempt,
        maxAttempts: attempts,
        category: err.category,
        retryable: true,
        severity: 'warn',
      });
      await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
    }
  }
  throw lastError; // unreachable; defensive
}

module.exports = { withRetry };
