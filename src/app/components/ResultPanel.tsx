'use client';

import { useState } from 'react';
import type { Attempt, IntakeResult, IntakeStatus } from '@/lib/agent/types';
import type { Issue } from '@/lib/validate';

const STATUS_STYLE: Record<IntakeStatus, { label: string; className: string; blurb: string }> = {
  valid: {
    label: 'Valid',
    className: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 ring-emerald-500/30',
    blurb: 'Read cleanly on the first attempt. No corrections needed.',
  },
  corrected: {
    label: 'Corrected',
    className: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 ring-amber-500/30',
    blurb: 'The first attempt failed validation. The agent was given the failures and its second attempt passed.',
  },
  needs_review: {
    label: 'Needs review',
    className: 'bg-rose-500/12 text-rose-700 dark:text-rose-400 ring-rose-500/30',
    blurb: 'Not fit to auto-approve. Routed to a human with the outstanding issues attached.',
  },
};

const ARABIC = /[؀-ۿ]/;

export function ResultPanel({ result }: { result: IntakeResult }) {
  const status = STATUS_STYLE[result.status];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ${status.className}`}
          >
            {status.label}
          </span>
          <p className="max-w-lg text-sm text-muted">{status.blurb}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-right text-xs text-muted sm:grid-cols-4">
          <Stat label="Attempts" value={String(result.attempts.length)} />
          <Stat label="Total" value={`${result.timings.totalMs}ms`} />
          <Stat label="In model" value={`${result.timings.modelMs}ms`} />
          <Stat
            label="Tokens"
            value={
              result.usage.input + result.usage.output === 0
                ? '—'
                : `${result.usage.input}/${result.usage.output}`
            }
          />
        </dl>
      </header>

      {result.issues.length > 0 && <IssueList issues={result.issues} />}

      <AttemptTrail attempts={result.attempts} />

      {result.record && <RecordTable record={result.record} />}

      <footer className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 font-mono text-[11px] text-muted">
        <span>provider {result.provider}</span>
        <span>model {result.model}</span>
        <span>sha256 {result.documentSha256.slice(0, 16)}…</span>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide opacity-70">{label}</dt>
      <dd className="font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  // Warnings do not block a record from being valid, so calling them
  // "outstanding issues" next to a green badge reads as a contradiction.
  const blocking = issues.some((i) => i.severity === 'error');

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {blocking ? 'Outstanding issues' : 'Warnings — noted, not blocking'}
      </h3>
      <ul className="space-y-2">
        {issues.map((issue) => (
          <li
            key={`${issue.code}:${issue.path}`}
            className="rounded-lg border border-line bg-surface p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-[11px] font-semibold">{issue.code}</code>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                  issue.kind === 'document'
                    ? 'bg-rose-500/12 text-rose-700 dark:text-rose-400'
                    : 'bg-sky-500/12 text-sky-700 dark:text-sky-400'
                }`}
                title={
                  issue.kind === 'document'
                    ? 'A fact about the licence. Re-reading it would not help, so the agent did not retry.'
                    : 'A misreading. This is the kind of issue fed back to the model for correction.'
                }
              >
                {issue.kind}
              </span>
              {issue.path && <code className="font-mono text-[11px] text-muted">{issue.path}</code>}
            </div>
            <p className="mt-1.5">{issue.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The attempt trail is the point of the demo, so it is not hidden behind a
 * toggle: when a correction happened, the fields that changed between the two
 * attempts are shown side by side.
 */
function AttemptTrail({ attempts }: { attempts: Attempt[] }) {
  const [showRaw, setShowRaw] = useState(false);
  const last = attempts.at(-1);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Attempts
        </h3>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
        >
          {showRaw ? 'Hide' : 'Show'} raw model output
        </button>
      </div>

      <ol className="space-y-2">
        {attempts.map((attempt, index) => {
          const previous = index > 0 ? attempts[index - 1] : undefined;
          const changes = previous ? diffRecords(previous.raw, attempt.raw) : [];

          return (
            <li key={attempt.index} className="rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium">Attempt {attempt.index + 1}</span>
                <span className="font-mono text-xs text-muted">{attempt.durationMs}ms</span>
                {attempt.issues.length === 0 ? (
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">
                    passed validation
                  </span>
                ) : (
                  <span className="text-xs text-muted">
                    {attempt.issues.length} issue{attempt.issues.length === 1 ? '' : 's'}:{' '}
                    <code className="font-mono">
                      {attempt.issues.map((i) => i.code).join(', ')}
                    </code>
                  </span>
                )}
              </div>

              {changes.length > 0 && (
                <div className="mt-3 space-y-2 border-t border-line pt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    What the agent changed
                  </p>
                  {changes.map((change) => (
                    <div key={change.path} className="text-xs">
                      <code className="font-mono text-[11px] text-muted">{change.path}</code>
                      <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                        <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded border border-rose-500/25 bg-rose-500/5 p-2 font-mono text-[11px]">
                          {change.before}
                        </pre>
                        <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded border border-emerald-500/25 bg-emerald-500/5 p-2 font-mono text-[11px]">
                          {change.after}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showRaw && (
                <pre className="mt-3 max-h-72 overflow-auto rounded border border-line bg-background p-2 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(attempt.raw, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ol>

      {last && last.issues.length > 0 && (
        <p className="text-xs text-muted">
          Attempt budget exhausted. The record above is returned for a human to review rather than
          being retried indefinitely.
        </p>
      )}
    </section>
  );
}

interface Change {
  path: string;
  before: string;
  after: string;
}

/** Shallow diff over the top-level fields — the schema is flat, so that is all it needs to be. */
function diffRecords(before: unknown, after: unknown): Change[] {
  if (!isRecord(before) || !isRecord(after)) return [];

  return Object.keys(after)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({
      path: key,
      before: format(before[key]),
      after: format(after[key]),
    }));
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.map((v, i) => `${i + 1}. ${String(v)}`).join('\n');
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function RecordTable({ record }: { record: Record<string, unknown> }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        Validated record
      </h3>
      <dl className="overflow-hidden rounded-lg border border-line">
        {Object.entries(record).map(([key, value], index) => (
          <div
            key={key}
            className={`grid gap-1 px-3 py-2 sm:grid-cols-[13rem_1fr] sm:gap-4 ${
              index % 2 ? 'bg-surface' : ''
            }`}
          >
            <dt className="font-mono text-[11px] text-muted sm:pt-0.5">{key}</dt>
            <dd className="text-sm">{renderValue(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function renderValue(value: unknown) {
  if (value === null || value === undefined) {
    return <span className="text-xs italic text-muted">null</span>;
  }

  if (Array.isArray(value)) {
    return (
      <ol className="list-inside list-decimal space-y-0.5">
        {value.map((item, index) => (
          <li key={index} dir={ARABIC.test(String(item)) ? 'rtl' : 'ltr'}>
            {String(item)}
          </li>
        ))}
      </ol>
    );
  }

  const text = String(value);
  return <span dir={ARABIC.test(text) ? 'rtl' : 'ltr'}>{text}</span>;
}
