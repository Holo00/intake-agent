import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { runIntake } from '@/lib/agent/run';
import {
  createStubProvider,
  fixtureResolver,
  withFault,
  type ExtractionRequest,
} from '@/lib/providers';
import { resetRunLog, recentRuns } from '@/lib/obs/run-log';

/**
 * The loop, driven by the stub provider against the real sample PDFs.
 *
 * Using the actual files rather than synthetic buffers means the stub's
 * hash-matching is exercised too — if `samples/generate.sh` is run and the
 * fixtures are not updated, these fail rather than silently testing nothing.
 */

const NOW = new Date('2026-08-13T00:00:00Z');

const load = async (id: string, mime: string) => ({
  bytes: await readFile(
    new URL(`../../public/samples/${id}.${mime === 'image/jpeg' ? 'jpg' : 'pdf'}`, import.meta.url),
  ),
  mime,
});

const run = async (
  id: string,
  { mime = 'application/pdf', ...overrides }: Partial<Parameters<typeof runIntake>[0]> & { mime?: string } = {},
) =>
  runIntake({
    provider: createStubProvider(),
    document: await load(id, mime),
    requestId: `test-${id}`,
    now: NOW,
    ...overrides,
  });

beforeEach(resetRunLog);

describe('a licence that reads cleanly', () => {
  it('returns `valid` after a single attempt', async () => {
    const result = await run('clean');

    expect(result.status).toBe('valid');
    expect(result.attempts).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(result.record?.licenceNumber).toBe('784512');
  });

  it('splits the activities into separate entries', async () => {
    const result = await run('clean');
    expect(result.record?.activities).toHaveLength(4);
  });
});

describe('a harder layout', () => {
  it('still reads cleanly — prose activities are split correctly', async () => {
    const result = await run('awkward');

    expect(result.status).toBe('valid');
    expect(result.record?.activities).toHaveLength(6);
  });
});

describe('a photographed copy', () => {
  it('reads cleanly from a JPEG, with no text-extraction step', async () => {
    const result = await run('scan', { mime: 'image/jpeg' });

    expect(result.status).toBe('valid');
    expect(result.record?.licenceNumber).toBe('CN-2094771');
  });
});

describe('an injected fault', () => {
  it('is caught and corrected on the second attempt', async () => {
    const result = await run('clean', {
      provider: withFault(createStubProvider(), 'join_activities'),
    });

    expect(result.status).toBe('corrected');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.issues.map((i) => i.code)).toContain('ACTIVITIES_NOT_SPLIT');
    expect(result.attempts[1]?.issues).toEqual([]);
    expect(result.record?.activities).toHaveLength(4);
  });

  it('catches transposed dates', async () => {
    const result = await run('clean', {
      provider: withFault(createStubProvider(), 'swap_dates'),
    });

    expect(result.attempts[0]?.issues.map((i) => i.code)).toContain('EXPIRY_NOT_AFTER_ISSUE');
    expect(result.status).toBe('corrected');
  });

  it('catches a transliterated Arabic name', async () => {
    const result = await run('clean', {
      provider: withFault(createStubProvider(), 'transliterate_arabic'),
    });

    expect(result.attempts[0]?.issues.map((i) => i.code)).toContain('ARABIC_NAME_NOT_ARABIC');
    expect(result.status).toBe('corrected');
  });

  it('passes the failing issues back to the provider on the retry', async () => {
    const seen: (ExtractionRequest['feedback'] | undefined)[] = [];
    const provider = withFault(
      createStubProvider((request) => {
        seen.push(request.feedback);
        return fixtureResolver(request);
      }),
      'join_activities',
    );

    await run('clean', { provider });

    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.issues.map((i) => i.code)).toEqual(['ACTIVITIES_NOT_SPLIT']);
    // The hint is what the model actually acts on, so it must survive the trip.
    expect(seen[1]?.issues[0]?.hint).toMatch(/one array entry per activity/i);
  });

  it('only corrupts the first attempt, or the loop could never recover', async () => {
    const result = await run('clean', {
      provider: withFault(createStubProvider(), 'join_activities'),
      maxAttempts: 2,
    });

    expect(result.attempts[1]?.issues).toEqual([]);
  });
});

describe('an expired licence', () => {
  it('returns `needs_review`', async () => {
    const result = await run('expired');
    expect(result.status).toBe('needs_review');
    expect(result.issues.map((i) => i.code)).toContain('LICENCE_EXPIRED');
  });

  it('does not retry, because re-reading cannot change the expiry date', async () => {
    const result = await run('expired');
    expect(result.attempts).toHaveLength(1);
  });

  it('still returns the extracted record for the human reviewer', async () => {
    const result = await run('expired');
    expect(result.record?.legalNameEn).toBe('Gulf Horizon Trading FZE');
  });
});

describe('the attempt budget', () => {
  it('stops at maxAttempts and reports `needs_review` rather than throwing', async () => {
    // A provider that never fixes the problem, however many times it is asked:
    // the fault is applied on every attempt, not just the first.
    const stubborn = createStubProvider((request) => {
      const record = fixtureResolver(request) as Record<string, unknown>;
      const activities = record.activities as string[];
      return { ...record, activities: [activities.map((a, i) => `${i + 1}. ${a}`).join(' ')] };
    });
    const result = await run('clean', { provider: stubborn, maxAttempts: 2 });

    expect(result.status).toBe('needs_review');
    expect(result.attempts).toHaveLength(2);
    expect(result.issues.map((i) => i.code)).toContain('ACTIVITIES_NOT_SPLIT');
  });

  it('honours a budget of one, disabling correction entirely', async () => {
    const result = await run('clean', {
      provider: withFault(createStubProvider(), 'join_activities'),
      maxAttempts: 1,
    });

    expect(result.status).toBe('needs_review');
    expect(result.attempts).toHaveLength(1);
  });
});

describe('structurally invalid model output', () => {
  it('is reported as needs_review with schema issues, not a crash', async () => {
    const nonsense = createStubProvider(() => ({ licenceNumber: 12345 }));
    const result = await run('clean', { provider: nonsense });

    expect(result.status).toBe('needs_review');
    expect(result.record).toBeNull();
    expect(result.issues.some((i) => i.code.startsWith('SCHEMA_'))).toBe(true);
  });
});

describe('the run log', () => {
  it('records the outcome without any field values', async () => {
    await run('clean');
    const [entry] = recentRuns();

    expect(entry?.status).toBe('valid');
    expect(entry?.documentSha256).toHaveLength(64);
    expect(JSON.stringify(entry)).not.toContain('784512');
    expect(JSON.stringify(entry)).not.toContain('Al Maha');
  });
});

describe('a document that is not a trade licence', () => {
  /** What the model returns for an invoice: a rejection and nothing else. */
  const rejecting = () =>
    createStubProvider(() => ({
      isTradeLicence: false,
      licenceNumber: null,
      legalNameEn: null,
      legalNameAr: null,
      tradeNameEn: null,
      tradeNameAr: null,
      legalForm: null,
      managerName: null,
      issuingAuthority: null,
      emirate: null,
      issueDate: null,
      expiryDate: null,
      establishmentDate: null,
      activities: [],
      registeredAddress: null,
    }));

  it('is rejected as needs_review', async () => {
    const result = await run('clean', { provider: rejecting() });

    expect(result.status).toBe('needs_review');
    expect(result.issues.map((i) => i.code)).toEqual(['NOT_A_TRADE_LICENCE']);
  });

  it('costs one attempt, not two — re-reading cannot change what it is', async () => {
    const result = await run('clean', { provider: rejecting() });
    expect(result.attempts).toHaveLength(1);
  });

  it('still returns the (empty) record rather than throwing', async () => {
    const result = await run('clean', { provider: rejecting() });
    expect(result.record).not.toBeNull();
    expect(result.record?.isTradeLicence).toBe(false);
  });
});

describe('a document the stub has never seen', () => {
  /**
   * Regression. This returned a placeholder record with isTradeLicence: true,
   * so a corrupt file — or a reviewer's own document dropped into stub mode —
   * came back `status: valid`. A demo whose argument is that plausible JSON is
   * not a correct record cannot itself do that.
   */
  it('declines rather than inventing a record', async () => {
    await expect(
      runIntake({
        provider: createStubProvider(),
        document: { bytes: Buffer.from('not a document at all'), mime: 'application/pdf' },
        requestId: 'unknown-doc',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'STUB_NO_FIXTURE' });
  });

  it('says what to do about it rather than just failing', async () => {
    await expect(
      runIntake({
        provider: createStubProvider(),
        document: { bytes: Buffer.from('nope'), mime: 'application/pdf' },
        requestId: 'unknown-doc-2',
        now: NOW,
      }),
    ).rejects.toThrow(/LLM_PROVIDER=gemini/);
  });
});
