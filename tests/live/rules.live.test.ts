import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import expectations from '@/../samples/malformed/expectations.json';
import { runIntake } from '@/lib/agent/run';
import { createGeminiProvider } from '@/lib/providers/gemini';

/**
 * The validation rules, checked against a real model reading genuinely
 * defective documents.
 *
 * Every other test in this repo drives the loop through the stub, which proves
 * the *plumbing* — the loop, the kinds, the feedback, the redaction — but
 * cannot tell you whether a rule fires on reality. A rule written against a
 * fixture and never seen against a real extraction is a rule you are guessing
 * about.
 *
 * These documents are wrong on the page: an expiry that precedes its issue
 * date, a date years in the future, no activities at all. The model reads them
 * correctly and validation is supposed to object. If it does not, the rule is
 * broken, or the schema description misled the model into normalising the
 * defect away — both worth knowing, neither visible offline.
 *
 * Opt-in, because it costs money and needs network:
 *
 *     RUN_LIVE_TESTS=1 GEMINI_API_KEY=... pnpm test:live
 *
 * CI does not run it. That is deliberate — a test suite that needs a funded
 * API key to go green is a test suite that eventually gets ignored.
 */

const enabled = process.env.RUN_LIVE_TESTS === '1' && Boolean(process.env.GEMINI_API_KEY);

// Fixed so the expiry/future rules test the same thing in six months.
const NOW = new Date('2026-08-13T00:00:00Z');

describe.skipIf(!enabled)('validation rules against a live model', () => {
  const provider = createGeminiProvider(
    process.env.GEMINI_API_KEY ?? '',
    process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
  );

  it.each(expectations)('$id raises $expect', async ({ id, file, expect: expected }) => {
    const result = await runIntake({
      provider,
      document: {
        bytes: await readFile(new URL(`../../samples/malformed/${file}`, import.meta.url)),
        mime: 'application/pdf',
      },
      requestId: `live-${id}`,
      now: NOW,
      // One attempt: these documents are genuinely defective, so a correction
      // pass would only confirm the same reading at twice the cost. Retrying
      // is also how you *discover* that, which is why the demo path allows it —
      // but here the expectation is about the rule, not the loop.
      maxAttempts: 1,
    });

    const codes = result.issues.map((i) => i.code);
    expect(codes, `${id}: got ${codes.join(', ') || 'no issues'}`).toContain(expected);
  }, 90_000);

  it('reads a clean licence without raising anything', async () => {
    const result = await runIntake({
      provider,
      document: {
        bytes: await readFile(new URL('../../public/samples/clean.pdf', import.meta.url)),
        mime: 'application/pdf',
      },
      requestId: 'live-clean',
      now: NOW,
      maxAttempts: 1,
    });

    // The control. Without it, a rule that fires on everything would still pass
    // every case above.
    expect(result.issues).toEqual([]);
    expect(result.status).toBe('valid');
  }, 90_000);
});
