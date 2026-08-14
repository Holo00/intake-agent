/**
 * The distinction this file exists to make:
 *
 *   `extraction` — the model misread the page. Re-reading it might fix this,
 *                  so these are the issues worth feeding back into a retry.
 *   `document`   — the document really is like that. An expired licence is
 *                  expired no matter how many times you look at it.
 *
 * Collapsing the two is the most common way an extract-and-validate pipeline
 * goes wrong: it burns retries trying to "correct" a true finding, and then
 * reports a real compliance problem as a parsing failure. Everything else in
 * the agent loop follows from keeping them apart.
 */
export type IssueKind = 'extraction' | 'document';

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  code: string;
  kind: IssueKind;
  severity: IssueSeverity;
  /** Dotted path into the record, e.g. `activities.0`. Empty for record-level issues. */
  path: string;
  /** Written for a human reading the result panel. */
  message: string;
  /** Written for the model on the correction attempt. Omitted where re-reading cannot help. */
  hint?: string;
}

/** Issues worth spending another model call on. */
export function retryable(issues: readonly Issue[]): Issue[] {
  return issues.filter((i) => i.kind === 'extraction' && i.severity === 'error');
}

/** True when the record is fit to return as clean. */
export function isClean(issues: readonly Issue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}
