import { createHash } from 'node:crypto';
import { config } from '@/lib/config';
import { IntakeError, isIntakeError } from '@/lib/errors';
import { log, fieldSummary } from '@/lib/obs/log';
import { correctionOverhead } from '@/lib/obs/cost';
import { recordRun } from '@/lib/obs/run-log';
import { tradeLicenceJsonSchema } from '@/lib/schema/trade-licence';
import { isClean, retryable, validate, type Issue } from '@/lib/validate';
import type { DocumentInput, ExtractionProvider } from '@/lib/providers';
import { extractionInstructions } from './instructions';
import type { Attempt, IntakeResult, IntakeStatus } from './types';

export interface RunOptions {
  provider: ExtractionProvider;
  document: DocumentInput;
  requestId: string;
  /** Injected so expiry rules are testable at a fixed date. */
  now?: Date;
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * Read → extract → validate → correct.
 *
 *   ┌── extract ──► validate ──► clean? ──► return
 *   │                  │
 *   └──── feedback ◄───┘  (only for issues re-reading can fix, and only once)
 *
 * What separates this from extract-then-validate:
 *
 *   1. Validation failures are fed back to the model as specific, actionable
 *      hints rather than "that was wrong, try again".
 *   2. Only `extraction` issues trigger a retry. A licence that expired in 2024
 *      is a finding, not a misread — retrying it would waste a call and invite
 *      the model to invent a date that passes.
 *   3. The budget is bounded and the failure is clean. Out of attempts means
 *      `needs_review` with the issues attached, never a throw and never a
 *      half-validated record presented as good.
 */
export async function runIntake(options: RunOptions): Promise<IntakeResult> {
  const {
    provider,
    document,
    requestId,
    now = new Date(),
    maxAttempts = config.MAX_ATTEMPTS,
    timeoutMs = config.EXTRACTION_TIMEOUT_MS,
  } = options;

  const startedAt = Date.now();
  const documentSha256 = createHash('sha256').update(document.bytes).digest('hex');

  // One deadline for the whole loop, not one per attempt. A caller that waits
  // 45s should not discover that two attempts means 90s.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  const attempts: Attempt[] = [];
  let modelMs = 0;
  let model = '';
  let best: { record: IntakeResult['record']; issues: Issue[] } | null = null;

  log.info('intake.started', {
    requestId,
    documentSha256,
    documentBytes: document.bytes.length,
    mime: document.mime,
    provider: provider.name,
    maxAttempts,
  });

  try {
    for (let index = 0; index < maxAttempts; index += 1) {
      const previous = attempts.at(-1);
      const attemptStart = Date.now();

      const response = await provider.extract({
        document,
        jsonSchema: tradeLicenceJsonSchema,
        instructions: extractionInstructions,
        signal: controller.signal,
        feedback: previous
          ? { previous: previous.raw, issues: retryable(previous.issues) }
          : undefined,
      });

      const durationMs = Date.now() - attemptStart;
      modelMs += durationMs;
      model = response.model;

      const result = validate(response.raw, { now });
      attempts.push({
        index,
        raw: response.raw,
        issues: result.issues,
        durationMs,
        usage: response.usage,
      });

      log.info('intake.attempt', {
        requestId,
        attempt: index,
        durationMs,
        issueCodes: result.issues.map((i) => i.code),
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        ...(result.record ? fieldSummary(result.record) : {}),
      });

      // Keep the last structurally valid record even if rules failed, so a
      // `needs_review` result still shows the reviewer what was read.
      if (result.record) best = { record: result.record, issues: result.issues };

      if (isClean(result.issues)) break;

      // Nothing left that another read could fix — stop early rather than
      // spending a call to be told the same thing.
      if (retryable(result.issues).length === 0) break;
    }
  } catch (cause) {
    log.error('intake.failed', {
      requestId,
      documentSha256,
      attempt: attempts.length,
      code: isIntakeError(cause) ? cause.code : 'INTERNAL',
      detail: isIntakeError(cause) ? cause.logDetail() : undefined,
    });
    throw isIntakeError(cause)
      ? cause
      : new IntakeError('INTERNAL', 'Extraction failed unexpectedly.', { cause });
  } finally {
    clearTimeout(deadline);
  }

  const issues = best?.issues ?? attempts.at(-1)?.issues ?? [];
  const status = decideStatus(attempts.length, issues, best !== null);

  const usage = attempts.reduce(
    (sum, a) => ({ input: sum.input + a.usage.input, output: sum.output + a.usage.output }),
    { input: 0, output: 0 },
  );

  const totalMs = Date.now() - startedAt;

  const result: IntakeResult = {
    status,
    record: best?.record ?? null,
    issues,
    attempts,
    provider: provider.name,
    model,
    documentSha256,
    timings: { totalMs, modelMs },
    usage,
  };

  log.info('intake.completed', {
    requestId,
    documentSha256,
    status,
    attempts: attempts.length,
    issueCodes: issues.map((i) => i.code),
    totalMs,
    modelMs,
    inputTokens: usage.input,
    outputTokens: usage.output,
    // What the correction actually cost, as a multiple of the first read.
    retryTokenMultiple: correctionOverhead(attempts).multiple,
  });

  const overhead = correctionOverhead(attempts);

  recordRun(
    {
      requestId,
      documentSha256,
      documentBytes: document.bytes.length,
      status,
      attempts: attempts.length,
      issueCodes: issues.map((i) => i.code),
      durationMs: totalMs,
      modelMs,
      inputTokens: usage.input,
      outputTokens: usage.output,
      provider: provider.name,
      at: new Date().toISOString(),
    },
    overhead.retryTokens,
  );

  return result;
}

function decideStatus(
  attemptCount: number,
  issues: readonly Issue[],
  hasRecord: boolean,
): IntakeStatus {
  if (!hasRecord || !isClean(issues)) return 'needs_review';
  return attemptCount > 1 ? 'corrected' : 'valid';
}
