import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { runIntake } from '@/lib/agent/run';
import { createStubProvider, withFault } from '@/lib/providers';
import { correctionOverhead, estimateCost } from '@/lib/obs/cost';
import { metrics } from '@/lib/obs/metrics';
import { resetRunLog } from '@/lib/obs/run-log';

const NOW = new Date('2026-08-13T00:00:00Z');

beforeEach(resetRunLog);

const run = async (id: string, fault?: 'join_activities') => {
  const stub = createStubProvider();
  return runIntake({
    provider: fault ? withFault(stub, fault) : stub,
    document: {
      bytes: await readFile(new URL(`../../public/samples/${id}.pdf`, import.meta.url)),
      mime: 'application/pdf',
    },
    requestId: `metrics-${id}`,
    now: NOW,
  });
};

describe('cost estimation', () => {
  it('returns null when no rates are configured, rather than guessing', () => {
    expect(estimateCost({ input: 1000, output: 500 }, null)).toBeNull();
  });

  it('prices input and output separately', () => {
    const cost = estimateCost(
      { input: 1_000_000, output: 1_000_000 },
      { inputPerMTok: 0.3, outputPerMTok: 2.5 },
    );
    expect(cost).toBeCloseTo(2.8, 6);
  });
});

describe('correction overhead', () => {
  it('is null when there was no retry', () => {
    expect(correctionOverhead([{ usage: { input: 700, output: 200 } }]).multiple).toBeNull();
  });

  /**
   * The point of the metric: a correction resends the document *and* the
   * previous answer *and* the errors, so it is not a cheap top-up.
   */
  it('reports the retry as a multiple of the first read', () => {
    const overhead = correctionOverhead([
      { usage: { input: 700, output: 200 } },
      { usage: { input: 1000, output: 350 } },
    ]);

    expect(overhead.firstTokens).toBe(900);
    expect(overhead.retryTokens).toBe(1350);
    expect(overhead.multiple).toBe(1.5);
  });
});

describe('metrics over real runs', () => {
  it('starts empty without dividing by zero', () => {
    const m = metrics();
    expect(m.runs).toBe(0);
    expect(m.correctionRate).toBeNull();
    expect(m.latency.p50Ms).toBeNull();
  });

  it('counts statuses and derives the correction rate', async () => {
    await run('clean');
    await run('expired');
    await run('clean', 'join_activities');

    const m = metrics();
    expect(m.runs).toBe(3);
    expect(m.byStatus).toMatchObject({ valid: 1, corrected: 1, needs_review: 1 });
    expect(m.correctionRate).toBeCloseTo(0.333, 3);
    expect(m.needsReviewRate).toBeCloseTo(0.333, 3);
  });

  it('ranks the validation rules that actually fired', async () => {
    await run('expired');
    await run('expired');
    await run('clean', 'join_activities');

    // The corrected run ends clean, so only the unresolved issues rank.
    expect(metrics().topIssues[0]).toEqual({ code: 'LICENCE_EXPIRED', count: 2 });
  });

  it('reports no cost when rates are unconfigured', async () => {
    await run('clean');
    const m = metrics();

    expect(m.cost.configured).toBe(false);
    expect(m.cost.total).toBeNull();
  });

  it('exposes a latency percentile once there is a window', async () => {
    await run('clean');
    expect(metrics().latency.p50Ms).not.toBeNull();
    expect(metrics().window).toBe(1);
  });
});
