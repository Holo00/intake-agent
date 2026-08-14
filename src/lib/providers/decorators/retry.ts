import { IntakeError, isIntakeError } from '@/lib/errors';
import { log } from '@/lib/obs/log';
import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from '../types';

/**
 * Retry on transient provider failures — a different axis from the agent loop.
 *
 * These two are easy to conflate and must not be:
 *
 *   the agent loop retries because the *answer* was wrong (validation failed).
 *   this retries because the *call* failed (429, 503, a dropped connection).
 *
 * Keeping them separate means a rate-limited request does not consume one of
 * the two correction attempts, and a genuinely wrong answer does not get
 * re-sent because the network hiccuped. Only `IntakeError.transient` codes
 * qualify: a 401 or a retired model will fail identically forever, and retrying
 * those is just a slower way to return the same error.
 *
 * Exponential backoff with full jitter. Jitter matters more than the backoff at
 * volume: without it, every request rate-limited in the same second retries in
 * the same later second, and the spike reproduces itself.
 */
export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  /** Injected in tests so backoff is deterministic and instant. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new IntakeError('PROVIDER_TIMEOUT', 'Extraction timed out.'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function withRetry(
  provider: ExtractionProvider,
  { maxRetries, baseDelayMs, sleep = defaultSleep, random = Math.random }: RetryOptions,
): ExtractionProvider {
  return {
    name: provider.name,

    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await provider.extract(request);
        } catch (cause) {
          const error = isIntakeError(cause)
            ? cause
            : new IntakeError('INTERNAL', 'Provider call failed.', { cause });

          if (!error.transient || attempt >= maxRetries) throw error;

          // Full jitter: a uniform draw from [0, exponential ceiling] rather
          // than the ceiling itself.
          const ceiling = baseDelayMs * 2 ** attempt;
          const delayMs = Math.round(random() * ceiling);

          log.warn('provider.retrying', {
            code: error.code,
            attempt,
            delayMs,
            remaining: maxRetries - attempt,
          });

          await sleep(delayMs, request.signal);
        }
      }
    },
  };
}
