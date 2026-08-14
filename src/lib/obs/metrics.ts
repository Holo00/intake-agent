import { config } from '@/lib/config';
import { estimateCost } from './cost';
import { lifetimeCounters, recentRuns } from './run-log';

/**
 * The operational view of the agent, derived from the run log.
 *
 * Chosen to answer the four questions actually asked of a system like this in
 * production:
 *
 *   How often does it work?          — status breakdown, correction rate
 *   How slow is it?                  — p50/p95, and how much of that is the model
 *   What does it cost?               — tokens and spend, including the retry premium
 *   Why is it failing?               — which validation rules fire, ranked
 *
 * That last one is the feedback loop that matters: a rule firing constantly is
 * not a validation problem, it is a schema or prompt problem, and the issue-code
 * ranking is what tells you which one to fix first.
 */
export interface Metrics {
  runs: number;
  byStatus: Record<string, number>;
  correctionRate: number | null;
  needsReviewRate: number | null;
  latency: { p50Ms: number | null; p95Ms: number | null; modelShare: number | null };
  tokens: { input: number; output: number; retry: number; retryShare: number | null };
  cost: { total: number | null; perRun: number | null; currency: 'USD'; configured: boolean };
  topIssues: { code: string; count: number }[];
  window: number;
}

export function metrics(): Metrics {
  const counters = lifetimeCounters();
  const window = recentRuns();

  const durations = window.map((r) => r.durationMs).sort((a, b) => a - b);
  const modelMs = window.reduce((sum, r) => sum + r.modelMs, 0);
  const totalMs = window.reduce((sum, r) => sum + r.durationMs, 0);

  const totalTokens = counters.inputTokens + counters.outputTokens;
  const cost = estimateCost(
    { input: counters.inputTokens, output: counters.outputTokens },
    config.rates,
  );

  return {
    runs: counters.runs,
    byStatus: counters.byStatus,
    correctionRate: rate(counters.byStatus.corrected, counters.runs),
    needsReviewRate: rate(counters.byStatus.needs_review, counters.runs),
    latency: {
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      modelShare: totalMs > 0 ? round(modelMs / totalMs) : null,
    },
    tokens: {
      input: counters.inputTokens,
      output: counters.outputTokens,
      retry: counters.retryTokens,
      retryShare: totalTokens > 0 ? round(counters.retryTokens / totalTokens) : null,
    },
    cost: {
      total: cost,
      perRun: cost !== null && counters.runs > 0 ? cost / counters.runs : null,
      currency: 'USD',
      configured: config.rates !== null,
    },
    topIssues: topIssues(window),
    window: window.length,
  };
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? round(part / whole) : null;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/** Nearest-rank percentile. Exact for the small windows this holds, unlike interpolation. */
function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

function topIssues(window: readonly { issueCodes: string[] }[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const run of window) {
    for (const code of run.issueCodes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 8);
}
