/**
 * One error type crosses the provider boundary.
 *
 * Adapters translate whatever their SDK throws — a Google `GoogleGenerativeAIError`,
 * a bare `fetch` failure, an `AbortError` from our own timeout — into exactly
 * these codes. Nothing above the adapter layer imports a vendor error type, which
 * is what makes swapping providers a one-file change rather than an audit.
 */
export type IntakeErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_MODEL_UNAVAILABLE'
  | 'PROVIDER_CONTENT_BLOCKED'
  | 'PROVIDER_BAD_RESPONSE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'NO_DOCUMENT'
  | 'INTERNAL';

const HTTP_STATUS: Record<IntakeErrorCode, number> = {
  PROVIDER_TIMEOUT: 504,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_AUTH: 500, // Our credential is wrong, not the caller's request.
  PROVIDER_MODEL_UNAVAILABLE: 500, // Likewise: our configuration, not their upload.
  PROVIDER_CONTENT_BLOCKED: 422,
  PROVIDER_BAD_RESPONSE: 502,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  NO_DOCUMENT: 400,
  INTERNAL: 500,
};

/** Codes where trying the same call again is reasonable. */
const TRANSIENT: ReadonlySet<IntakeErrorCode> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
]);

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;
  readonly status: number;
  readonly transient: boolean;
  /**
   * How long the provider asked us to wait, in milliseconds, when it said so.
   *
   * Gemini returns a `RetryInfo.retryDelay` alongside a 429 — the server knows
   * when its window reopens and we do not. Guessing with exponential backoff
   * when the answer was in the response is how a client hammers an API that
   * politely told it to wait: our default ceiling is ~2s against a stated 49s,
   * so every retry was spent before the window could possibly have reopened.
   */
  readonly retryAfterMs?: number;

  constructor(
    code: IntakeErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = 'IntakeError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.transient = TRANSIENT.has(code);
    this.retryAfterMs = options?.retryAfterMs;
  }

  /**
   * Safe to send to the browser: a stable code and a message we wrote. The
   * underlying SDK message is deliberately not forwarded — provider errors can
   * echo request content, and that content is a customer's licence.
   */
  toPublic(): { code: IntakeErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }

  /**
   * The underlying provider message, for logs only — never for the client.
   *
   * Omitting this entirely was a mistake: the first live run failed with a
   * retired model and the reason appeared nowhere, because the code was logged
   * and the cause discarded. An operator needs the vendor's words.
   *
   * Truncated because these can be long, and the client never sees it because
   * `toPublic()` is what crosses the wire.
   */
  logDetail(): string | undefined {
    const cause = this.cause;
    if (!(cause instanceof Error)) return undefined;
    return cause.message.slice(0, 300);
  }
}

export function isIntakeError(e: unknown): e is IntakeError {
  return e instanceof IntakeError;
}
