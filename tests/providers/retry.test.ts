import { describe, expect, it, vi } from 'vitest';
import { IntakeError } from '@/lib/errors';
import { withRetry } from '@/lib/providers';
import type { ExtractionProvider, ExtractionRequest } from '@/lib/providers';

/**
 * Transient-failure retry, which is a different axis from the agent loop: this
 * retries because the *call* failed, the loop retries because the *answer* was
 * wrong. Conflating them would let a rate-limit burn a correction attempt.
 *
 * Sleep and jitter are injected so backoff is deterministic and instant.
 */

const request = (): ExtractionRequest => ({
  document: { bytes: Buffer.from('x'), mime: 'application/pdf' },
  jsonSchema: {},
  instructions: '',
  signal: new AbortController().signal,
});

/** Fails `failures` times with `error`, then succeeds. */
function flaky(failures: number, error: Error): ExtractionProvider & { calls: number } {
  const provider = {
    calls: 0,
    name: 'flaky',
    async extract() {
      provider.calls += 1;
      if (provider.calls <= failures) throw error;
      return { raw: { ok: true }, model: 'flaky', usage: { input: 1, output: 1 } };
    },
  };
  return provider;
}

const instant = { sleep: async () => {}, random: () => 1 };

describe('transient failures', () => {
  it('retries a rate limit and succeeds', async () => {
    const provider = flaky(2, new IntakeError('PROVIDER_RATE_LIMITED', 'slow down'));
    const result = await withRetry(provider, { maxRetries: 3, baseDelayMs: 10, ...instant }).extract(
      request(),
    );

    expect(result.raw).toEqual({ ok: true });
    expect(provider.calls).toBe(3);
  });

  it('gives up after maxRetries and rethrows', async () => {
    const provider = flaky(99, new IntakeError('PROVIDER_UNAVAILABLE', 'down'));
    const wrapped = withRetry(provider, { maxRetries: 2, baseDelayMs: 10, ...instant });

    await expect(wrapped.extract(request())).rejects.toThrow(/down/);
    expect(provider.calls).toBe(3); // the initial attempt plus two retries
  });
});

describe('permanent failures', () => {
  it('does not retry an auth error', async () => {
    const provider = flaky(99, new IntakeError('PROVIDER_AUTH', 'bad key'));
    const wrapped = withRetry(provider, { maxRetries: 3, baseDelayMs: 10, ...instant });

    await expect(wrapped.extract(request())).rejects.toThrow(/bad key/);
    expect(provider.calls).toBe(1);
  });

  it('does not retry a retired model', async () => {
    const provider = flaky(99, new IntakeError('PROVIDER_MODEL_UNAVAILABLE', 'gone'));
    const wrapped = withRetry(provider, { maxRetries: 3, baseDelayMs: 10, ...instant });

    await expect(wrapped.extract(request())).rejects.toThrow(/gone/);
    expect(provider.calls).toBe(1);
  });

  it('does not retry a validation-shaped failure it never sees', async () => {
    // Anything not an IntakeError is wrapped as INTERNAL, which is not transient.
    const provider = flaky(99, new TypeError('bug'));
    const wrapped = withRetry(provider, { maxRetries: 3, baseDelayMs: 10, ...instant });

    await expect(wrapped.extract(request())).rejects.toThrow(/Provider call failed/);
    expect(provider.calls).toBe(1);
  });
});

describe('backoff', () => {
  it('grows exponentially and applies full jitter', async () => {
    const delays: number[] = [];
    const provider = flaky(3, new IntakeError('PROVIDER_RATE_LIMITED', 'slow down'));

    await withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 100,
      random: () => 1, // full ceiling, so the exponential shape is observable
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).extract(request());

    expect(delays).toEqual([100, 200, 400]);
  });

  it('draws below the ceiling when jitter is low', async () => {
    const delays: number[] = [];
    const provider = flaky(1, new IntakeError('PROVIDER_RATE_LIMITED', 'slow down'));

    await withRetry(provider, {
      maxRetries: 2,
      baseDelayMs: 100,
      random: () => 0.25,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).extract(request());

    expect(delays).toEqual([25]);
  });
});

describe('cancellation', () => {
  /**
   * Exercises the real backoff timer, not an injected one: a run that hits its
   * deadline while waiting to retry must abandon the wait rather than sit out a
   * long sleep the caller is no longer waiting for.
   */
  it('stops waiting when the run deadline fires mid-backoff', async () => {
    const controller = new AbortController();
    const provider = flaky(99, new IntakeError('PROVIDER_RATE_LIMITED', 'slow down'));

    // A 30s backoff the abort must cut short well inside the test timeout.
    const wrapped = withRetry(provider, { maxRetries: 5, baseDelayMs: 30_000, random: () => 1 });
    const started = Date.now();

    setTimeout(() => controller.abort(), 50);

    await expect(wrapped.extract({ ...request(), signal: controller.signal })).rejects.toThrow(
      /timed out/,
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(provider.calls).toBe(1);
  });
});

describe('the wrapper is transparent', () => {
  it('keeps the underlying provider name, so logs are unchanged', () => {
    const provider = flaky(0, new Error('unused'));
    expect(withRetry(provider, { maxRetries: 1, baseDelayMs: 1 }).name).toBe('flaky');
  });

  it('passes the request through untouched', async () => {
    const seen = vi.fn();
    const provider: ExtractionProvider = {
      name: 'spy',
      async extract(req) {
        seen(req.instructions);
        return { raw: {}, model: 'spy', usage: { input: 0, output: 0 } };
      },
    };

    await withRetry(provider, { maxRetries: 1, baseDelayMs: 1, ...instant }).extract({
      ...request(),
      instructions: 'read the licence',
    });

    expect(seen).toHaveBeenCalledWith('read the licence');
  });
});
