/**
 * Recent runs and lifetime counters, held in memory.
 *
 * An intake pipeline needs an audit trail — which documents were processed,
 * what was decided, how often the agent had to correct itself, what it cost.
 * That belongs in a database, and a database holding extracted licence fields
 * needs encryption at rest, a retention policy and a deletion path. All of that
 * is out of scope here (see docs/DECISIONS.md), so this keeps the *shape* of an
 * audit trail and drops the liability: entries carry a document hash, issue
 * codes and token counts, never a field value, so nothing here is personal data.
 *
 * Two tiers, because they answer different questions:
 *   - lifetime counters: totals since boot, cheap and unbounded in time.
 *   - a bounded ring of recent runs: enough to compute latency percentiles and
 *     see which validation rules are actually firing.
 *
 * At production volume this is a metrics backend rather than a module-level
 * array — but the shape of what you would export is exactly this.
 */
import type { IntakeStatus } from '@/lib/agent/types';

export interface RunLogEntry {
  requestId: string;
  documentSha256: string;
  documentBytes: number;
  status: IntakeStatus;
  attempts: number;
  issueCodes: string[];
  durationMs: number;
  modelMs: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  at: string;
}

interface Counters {
  runs: number;
  byStatus: Record<IntakeStatus, number>;
  inputTokens: number;
  outputTokens: number;
  /** Tokens spent on correction attempts alone — the cost of the loop. */
  retryTokens: number;
}

const CAPACITY = 100;
const entries: RunLogEntry[] = [];

const counters: Counters = {
  runs: 0,
  byStatus: { valid: 0, corrected: 0, needs_review: 0 },
  inputTokens: 0,
  outputTokens: 0,
  retryTokens: 0,
};

export function recordRun(entry: RunLogEntry, retryTokens: number): void {
  entries.unshift(entry);
  if (entries.length > CAPACITY) entries.length = CAPACITY;

  counters.runs += 1;
  counters.byStatus[entry.status] += 1;
  counters.inputTokens += entry.inputTokens;
  counters.outputTokens += entry.outputTokens;
  counters.retryTokens += retryTokens;
}

export function recentRuns(): readonly RunLogEntry[] {
  return entries;
}

export function lifetimeCounters(): Readonly<Counters> {
  return counters;
}

/** Test helper — module state would otherwise leak between tests. */
export function resetRunLog(): void {
  entries.length = 0;
  counters.runs = 0;
  counters.byStatus = { valid: 0, corrected: 0, needs_review: 0 };
  counters.inputTokens = 0;
  counters.outputTokens = 0;
  counters.retryTokens = 0;
}
