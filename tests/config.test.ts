import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Environment parsing, pinned against two bugs found the first time this was
 * started with an env file copied from `.env.example`.
 *
 * Both came from the same root cause: a deployment platform, or a copied
 * example file, hands over an empty string for a variable nobody filled in.
 * Taken at face value that is *present but wrong*, not absent.
 *
 * The schema is rebuilt here rather than imported because `config.ts` parses
 * `process.env` at module load — importing it would test whatever this test
 * runner happens to have in its environment, which is exactly the kind of test
 * that passes locally and fails in CI.
 */

const blankAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

describe('a blank credential', () => {
  const key = blankAsUndefined(z.string().min(1).optional());

  it('is treated as absent, not as a too-short string', () => {
    // `GEMINI_API_KEY=` in a .env file refused to boot even under the stub
    // provider, because an empty string is present and `.optional()` does not
    // rescue it.
    expect(key.parse('')).toBeUndefined();
    expect(key.parse('   ')).toBeUndefined();
  });

  it('still accepts a real key and still rejects nothing else', () => {
    expect(key.parse('AIzaSyExample')).toBe('AIzaSyExample');
    expect(key.parse(undefined)).toBeUndefined();
  });
});

describe('a blank number', () => {
  const price = blankAsUndefined(z.coerce.number().nonnegative().optional());

  it('is absent rather than zero', () => {
    // The dangerous one. `Number('')` is 0, so `COST_INPUT_PER_MTOK=` would
    // have configured a token price of zero and reported a confident $0.0000
    // spend — the exact failure `obs/cost.ts` exists to avoid.
    expect(price.parse('')).toBeUndefined();
  });

  it('still reads a real price, including a legitimate zero', () => {
    expect(price.parse('0.30')).toBe(0.3);
    expect(price.parse('0')).toBe(0);
  });
});

describe('a blank value with a default', () => {
  const attempts = blankAsUndefined(z.coerce.number().int().min(1).max(5).default(2));

  it('falls back to the default instead of coercing to zero and failing', () => {
    expect(attempts.parse('')).toBe(2);
    expect(attempts.parse(undefined)).toBe(2);
  });

  it('still honours an explicit value and still rejects an invalid one', () => {
    expect(attempts.parse('3')).toBe(3);
    expect(() => attempts.parse('9')).toThrow();
  });
});

describe('a blank enum', () => {
  const provider = blankAsUndefined(z.enum(['gemini', 'stub']).default('stub'));

  it('falls back to the stub, so a fresh clone runs', () => {
    expect(provider.parse('')).toBe('stub');
  });

  it('still rejects an unknown provider rather than silently defaulting', () => {
    expect(() => provider.parse('openai')).toThrow();
  });
});
