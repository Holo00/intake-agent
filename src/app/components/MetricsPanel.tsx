'use client';

import type { Metrics } from '@/lib/obs/metrics';

/**
 * The operational view, on the page rather than buried in an endpoint.
 *
 * Metrics that only exist at `/api/health` are metrics nobody looks at. These
 * are the four questions actually asked of a system like this in production —
 * how often does it work, how slow is it, what does it cost, and which rule is
 * failing — so they belong where the runs happen.
 *
 * Purely presentational: the initial value is server-rendered and the refresh
 * happens where a run completes, so this component fetches nothing.
 */
export function MetricsPanel({ metrics }: { metrics: Metrics | null }) {
  if (!metrics || metrics.runs === 0) {
    return (
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Session metrics</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Run a sample and this fills in — status breakdown, correction rate, latency percentiles,
          token spend and which validation rules are firing. Same data as{' '}
          <a href="/api/health" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
            /api/health
          </a>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Session metrics</h2>
        <a
          href="/api/health"
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-muted underline underline-offset-2 hover:text-foreground"
        >
          /api/health
        </a>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Metric label="Runs" value={String(metrics.runs)} />
        <Metric label="Corrected" value={percent(metrics.correctionRate)} />
        <Metric label="Needs review" value={percent(metrics.needsReviewRate)} />
        <Metric
          label="In model"
          value={percent(metrics.latency.modelShare)}
          hint="Share of wall-clock spent waiting on the provider. The rest is validation, which is free by comparison."
        />
        <Metric label="p50" value={ms(metrics.latency.p50Ms)} />
        <Metric label="p95" value={ms(metrics.latency.p95Ms)} />
        <Metric
          label="Tokens"
          value={`${metrics.tokens.input + metrics.tokens.output}`}
          hint="Input plus output across every attempt this session."
        />
        <Metric
          label="Spent on retries"
          value={percent(metrics.tokens.retryShare)}
          hint="A correction resends the document, the previous answer and the validation errors — so it costs more than the first read, not less. This is the number to budget from."
        />
      </dl>

      {metrics.cost.configured ? (
        <p className="text-xs text-muted">
          Estimated spend{' '}
          <span className="font-mono text-foreground">${metrics.cost.total?.toFixed(4)}</span> ·{' '}
          <span className="font-mono">${metrics.cost.perRun?.toFixed(4)}</span> per run
        </p>
      ) : (
        <p className="text-xs text-muted">
          Cost in currency is omitted because no token rates are configured. A hardcoded price goes
          stale and reports confident, wrong money — set{' '}
          <code className="font-mono">COST_INPUT_PER_MTOK</code> and{' '}
          <code className="font-mono">COST_OUTPUT_PER_MTOK</code> to enable it.
        </p>
      )}

      {metrics.topIssues.length > 0 && (
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Rules firing
          </p>
          <p className="text-xs leading-relaxed text-muted">
            A rule firing constantly is a schema or prompt problem, not a validation problem. This
            ranking is what tells you which to fix first.
          </p>
          <ul className="flex flex-wrap gap-1.5 pt-1">
            {metrics.topIssues.map((issue) => (
              <li
                key={issue.code}
                className="rounded border border-line px-2 py-1 font-mono text-[11px]"
              >
                {issue.code} <span className="text-muted">×{issue.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function ms(value: number | null): string {
  return value === null ? '—' : `${value}ms`;
}
