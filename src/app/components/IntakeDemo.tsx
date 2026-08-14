'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type IntakeApiResponse, type IntakeResult } from '@/lib/agent/types';
import type { Metrics } from '@/lib/obs/metrics';
import { MetricsPanel } from './MetricsPanel';
import { ResultPanel } from './ResultPanel';

export interface Sample {
  id: string;
  group: 'licence' | 'reject';
  file: string;
  label: string;
  description: string;
}

export interface FaultOption {
  name: string;
  label: string;
  detail: string;
}

type State =
  | { phase: 'idle' }
  | { phase: 'working'; source: string }
  | { phase: 'done'; source: string; result: IntakeResult }
  | { phase: 'failed'; source: string; code: string; message: string };

export function IntakeDemo({ samples, faults }: { samples: Sample[]; faults: FaultOption[] }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [fault, setFault] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLElement>(null);

  /**
   * The controls are taller than the viewport, so without this the result
   * lands below the fold and the app looks like it did nothing. Scrolling on
   * `working` rather than on `done` means the spinner is what you land on —
   * feedback arrives immediately instead of after the model call returns.
   */
  const revealResult = useCallback(() => {
    requestAnimationFrame(() =>
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }, []);

  const submit = useCallback(
    async (file: File, source: string, faultName: string) => {
    setState({ phase: 'working', source });
    revealResult();

    const body = new FormData();
    body.append('file', file);
    if (faultName) body.append('fault', faultName);

    try {
      const response = await fetch('/api/intake', { method: 'POST', body });
      const payload: IntakeApiResponse = await response.json();

      if (isApiError(payload)) {
        setState({
          phase: 'failed',
          source,
          code: payload.error.code,
          message: payload.error.message,
        });
        return;
      }

      setState({ phase: 'done', source, result: payload });
    } catch {
      setState({
        phase: 'failed',
        source,
        code: 'NETWORK',
        message: 'Could not reach the intake endpoint.',
      });
    } finally {
      // Refresh the operational view from the same endpoint an operator would
      // use, rather than deriving it client-side from this one run.
      try {
        const health = await fetch('/api/health');
        setMetrics(((await health.json()) as { metrics: Metrics }).metrics);
      } catch {
        // Metrics are diagnostic; failing to refresh them must not surface as
        // a failed extraction.
      }
    }
    },
    [revealResult],
  );

  /** Sample buttons fetch the file and post it through the same route as an upload. */
  const runSample = useCallback(
    async (sample: Sample) => {
      setState({ phase: 'working', source: sample.label });
      revealResult();
      const response = await fetch(sample.file);
      const blob = await response.blob();
      const name = sample.file.split('/').pop() ?? sample.id;
      await submit(new File([blob], name, { type: blob.type }), sample.label, fault);
    },
    [submit, fault, revealResult],
  );

  /**
   * Metrics are loaded over HTTP rather than server-rendered, and that is not
   * laziness.
   *
   * The run log is module-level state, and in Next.js a server component and a
   * route handler do not share a module graph — they are separate bundles with
   * separate instances. Calling `metrics()` from the page returned zero while
   * `/api/health` reported three runs from the same process. Reading it over
   * the same endpoint an operator would use is the only version that is true.
   *
   * It is also a fair argument against in-memory state generally: see decision
   * 7 on why the real answer is a metrics backend, not a longer array.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const health = await fetch('/api/health');
        const payload = (await health.json()) as { metrics: Metrics };
        if (!cancelled) setMetrics(payload.metrics);
      } catch {
        // Diagnostic only — never surfaced as a failure.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const busy = state.phase === 'working';
  const activeFault = faults.find((f) => f.name === fault);

  return (
    /*
     * Controls left, results right, and the controls stay put.
     *
     * Stacked vertically the control block ran past the fold, so every result
     * arrived off-screen and the app looked inert. A sticky sidebar fixes that
     * at the source rather than papering over it with a scroll: on a laptop
     * you click a sample and the result appears beside it, no scrolling at all.
     * The wide column goes to the results because that is what is actually
     * wide — record tables, attempt diffs, raw JSON.
     */
    <div className="lg:grid lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <aside className="space-y-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:pr-1">
        <SampleGroup
          title="Try a licence"
          samples={samples.filter((s) => s.group === 'licence')}
          busy={busy}
          onRun={runSample}
        />

        <SampleGroup
          title="Not a licence"
          blurb="The commonest thing an intake endpoint receives after the correct document. Rejected in one attempt."
          samples={samples.filter((s) => s.group === 'reject')}
          busy={busy}
          onRun={runSample}
        />

        <FaultPicker faults={faults} value={fault} onChange={setFault} active={activeFault} />

      </aside>

      <div className="mt-8 space-y-6 lg:mt-0">
        <section className="space-y-2">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void submit(file, file.name, fault);
            }}
            className={`rounded-lg border border-dashed p-5 text-center transition ${
              dragging ? 'border-foreground bg-surface' : 'border-line'
            }`}
          >
            <p className="text-sm text-muted">
              Or drop your own document here —{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
              >
                choose a file
              </button>
            </p>
            <p className="mt-1 text-[11px] text-muted/70">
              PDF, PNG, JPEG or WebP · up to 10MB · nothing is stored
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void submit(file, file.name, fault);
                e.target.value = '';
              }}
            />
          </div>
        </section>

        <section ref={resultRef} aria-live="polite" className="scroll-mt-6">
          {state.phase === 'idle' && (
            <div className="rounded-lg border border-dashed border-line p-8 text-center">
              <p className="text-sm text-muted">Pick a document on the left to run the agent.</p>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted/70">
                You will see the validated record, every attempt it took to get there, and — when a
                correction happened — a diff of exactly what changed between them.
              </p>
            </div>
          )}

          {state.phase === 'working' && (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-4 text-sm">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
              Reading {state.source}…
            </div>
          )}

          {state.phase === 'failed' && (
            <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
              <code className="font-mono text-xs font-semibold">{state.code}</code>
              <p>{state.message}</p>
              {state.code === 'STUB_NO_FIXTURE' && (
              <p className="text-xs leading-relaxed text-muted">
                The sample buttons above still work — they are the documents this mode has canned
                responses for. Everything except the model call is real either way.
              </p>
            )}
            {state.code === 'PROVIDER_RATE_LIMITED' && (
                <p className="text-xs leading-relaxed text-muted">
                  This instance runs on Gemini&apos;s free tier, which allows 20 model calls per day.
                  That allowance is spent for today — nothing is broken, and what you are seeing is
                  the error path doing its job: jittered retries honouring the delay the provider
                  asked for, then a clean 429 with a stable code rather than a stack trace.
                  Everything except the model call is exercised by the offline tests in the repo,
                  which need no key.
                </p>
              )}
            </div>
          )}

          {state.phase === 'done' && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold">Result — {state.source}</h2>
              <ResultPanel result={state.result} />
            </div>
          )}
        </section>

        <MetricsPanel metrics={metrics} />
      </div>
    </div>
  );
}

function SampleGroup({
  title,
  blurb,
  samples,
  busy,
  onRun,
}: {
  title: string;
  blurb?: string;
  samples: Sample[];
  busy: boolean;
  onRun: (sample: Sample) => void;
}) {
  if (samples.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {blurb && <p className="text-[11px] leading-snug text-muted">{blurb}</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {samples.map((sample) => (
          <div
            key={sample.id}
            className="group flex flex-col rounded-lg border border-line bg-surface"
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => onRun(sample)}
              className="flex-1 rounded-t-lg p-3 text-left transition hover:bg-foreground/4 disabled:opacity-50"
            >
              <span className="block text-[13px] font-medium">{sample.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                {sample.description}
              </span>
            </button>
            <a
              href={sample.file}
              download
              title="Download this file and upload it yourself, through the same route"
              className="border-t border-line px-3 py-1.5 text-[10px] text-muted/70 transition hover:text-foreground"
            >
              download ↓
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The correction loop only runs when validation fails, and a current model
 * reads these specimens correctly — including the photographed one. Rather than
 * engineer a document to defeat it, the failure is injected and labelled.
 */
function FaultPicker({
  faults,
  value,
  onChange,
  active,
}: {
  faults: FaultOption[];
  value: string;
  onChange: (next: string) => void;
  active: FaultOption | undefined;
}) {
  return (
    <section className="space-y-2.5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3.5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Inject a fault — see the agent correct itself</h2>
        {/*
          A <details> may not live inside a <p>: the parser closes the paragraph
          before it, so the browser's DOM stops matching the server-rendered
          HTML and React throws a hydration error. Siblings inside a <div>.
        */}
        <div className="space-y-1 text-xs leading-snug text-muted">
          <p>
            Corrupts the <strong>first</strong> attempt on the way back from the real provider, then
            pick any sample. Everything after the corruption is genuine.
          </p>
          <details>
            <summary className="cursor-pointer underline underline-offset-2 hover:text-foreground">
              why inject rather than find a document that breaks it?
            </summary>
            <span className="mt-1 block leading-relaxed">
              A current model reads every sample above correctly, including the photograph, so the
              correction loop never fires — which is the right outcome. Engineering a document to
              defeat a frontier model is fragile: it stops working the week the model improves, and
              a reviewer who knows these systems would see a demo tuned to make a model fail. The
              loop is insurance, and this is how you exercise insurance on purpose.
            </span>
          </details>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <FaultChip label="None" selected={value === ''} onClick={() => onChange('')} />
        {faults.map((f) => (
          <FaultChip
            key={f.name}
            label={f.label}
            selected={value === f.name}
            onClick={() => onChange(f.name)}
          />
        ))}
      </div>

      {active && <p className="text-xs leading-relaxed text-muted">{active.detail}</p>}
    </section>
  );
}

function FaultChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full border px-3 py-1.5 text-xs transition ${
        selected
          ? 'border-sky-500/50 bg-sky-500/15 font-medium text-foreground'
          : 'border-line text-muted hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}
