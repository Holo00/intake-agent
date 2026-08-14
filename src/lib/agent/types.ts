import type { TradeLicence } from '@/lib/schema/trade-licence';
import type { Issue } from '@/lib/validate';
import type { TokenUsage } from '@/lib/providers';

/**
 * Three terminal states, and the loop returns one of them or throws an
 * `IntakeError`. There is no fourth state and no partial success.
 *
 *   valid        — read cleanly on the first attempt.
 *   corrected    — the first attempt failed validation, the model was given the
 *                  failures and its second attempt passed. This is the state
 *                  the demo exists to show.
 *   needs_review — still failing after the attempt budget, or the document
 *                  itself has a problem no amount of re-reading fixes (an
 *                  expired licence). Route to a human; never auto-approve.
 */
export type IntakeStatus = 'valid' | 'corrected' | 'needs_review';

export interface Attempt {
  index: number;
  /** Unvalidated model output, exactly as returned. Surfaced so the correction is visible. */
  raw: unknown;
  issues: Issue[];
  durationMs: number;
  usage: TokenUsage;
}

export interface IntakeResult {
  status: IntakeStatus;
  /** Null only when no attempt produced a structurally valid record. */
  record: TradeLicence | null;
  /** Issues outstanding against the returned record. Empty when status is `valid`. */
  issues: Issue[];
  attempts: Attempt[];
  provider: string;
  model: string;
  documentSha256: string;
  timings: {
    totalMs: number;
    /** Time inside provider calls. The remainder is validation, which is free by comparison. */
    modelMs: number;
  };
  usage: TokenUsage;
}

/** What `POST /api/intake` returns. Success and failure are both JSON, both carry the request id. */
export type IntakeApiResponse =
  | ({ requestId: string } & IntakeResult)
  | { requestId: string; error: { code: string; message: string } };

export function isApiError(
  response: IntakeApiResponse,
): response is { requestId: string; error: { code: string; message: string } } {
  return 'error' in response;
}
