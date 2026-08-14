'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type IntakeApiResponse, type IntakeResult } from '@/lib/agent/types';
import type { Metrics } from '@/lib/obs/metrics';
import { MetricsPanel } from './MetricsPanel';
import { ResultPanel } from './ResultPanel';

export interface Sample {
  id: string;
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

  const submit = useCallback(async (file: File, source: string, faultName: string) => {
    setState({ phase: 'working', source });

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
  }, []);

  /** Sample buttons fetch the file and post it through the same route as an upload. */
  const runSample = useCallback(
    async (sample: Sample) => {
      setState({ phase: 'working', source: sample.label });
      const response = await fetch(sample.file);
      const blob = await response.blob();
      const name = sample.file.split('/').pop() ?? sample.id;
      await submit(new File([blob], name, { type: blob.type }), sample.label, fault);
    },
    [submit, fault],
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
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Try a sample</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {samples.map((sample) => (
            <div key={sample.id} className="flex flex-col rounded-lg border border-line bg-surface">
              <button
                type="button"
                disabled={busy}
                onClick={() => runSample(sample)}
                className="flex-1 p-3.5 text-left transition hover:bg-foreground/4 disabled:opacity-50"
              >
                <span className="block text-sm font-medium">{sample.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">
                  {sample.description}
                </span>
              </button>
              <a
                href={sample.file}
                download
                className="border-t border-line px-3.5 py-2 text-[11px] text-muted transition hover:text-foreground"
              >
                Download it and upload it yourself ↓
              </a>
            </div>
          ))}
        </div>
      </section>

      <FaultPicker faults={faults} value={fault} onChange={setFault} active={activeFault} />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Or drop your own</h2>
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
          className={`rounded-lg border border-dashed p-8 text-center transition ${
            dragging ? 'border-foreground bg-surface' : 'border-line'
          }`}
        >
          <p className="text-sm text-muted">
            Drop a PDF or image here, or{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            >
              choose a file
            </button>
            .
          </p>
          <p className="mt-1.5 text-xs text-muted/70">PDF, PNG, JPEG or WebP · up to 10MB</p>
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

      <section aria-live="polite" className="min-h-8">
        {state.phase === 'working' && (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-4 text-sm">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
            Reading {state.source}…
          </div>
        )}

        {state.phase === 'failed' && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
            <code className="font-mono text-xs font-semibold">{state.code}</code>
            <p className="mt-1">{state.message}</p>
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
    <section className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Inject a fault — see the agent correct itself</h2>
        <p className="text-xs leading-relaxed text-muted">
          A current model reads every sample above correctly, so the correction loop never fires.
          That is the right outcome, and a demo that relied on tricking the model into failing would
          stop working the week the model improved. Instead the <strong>first</strong> attempt&apos;s
          output is corrupted on the way back from the real provider. Everything after that is
          genuine: real validation, real hints, a real second call, a real corrected record.
        </p>
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
