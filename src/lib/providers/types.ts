import type { Issue } from '@/lib/validate';

export interface DocumentInput {
  bytes: Buffer;
  mime: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ExtractionRequest {
  document: DocumentInput;
  /** JSON Schema derived from the Zod schema — the model's output contract. */
  jsonSchema: object;
  /** What the document is and how to read it. Provider-neutral. */
  instructions: string;
  /**
   * Present only on a correction attempt. The adapter is responsible for
   * presenting these to the model in whatever shape its API prefers.
   */
  feedback?: {
    previous: unknown;
    issues: Issue[];
  };
  signal: AbortSignal;
}

export interface ExtractionResponse {
  /** Parsed JSON, unvalidated. Truth is the validation layer's job, not the adapter's. */
  raw: unknown;
  model: string;
  usage: TokenUsage;
}

/**
 * The entire surface an LLM provider has to satisfy.
 *
 * Deliberately one method. Everything specific to a vendor — how a PDF is
 * attached, how structured output is constrained, how errors are named — lives
 * behind it, so the extraction service and the agent loop contain no vendor
 * code at all.
 */
export interface ExtractionProvider {
  readonly name: string;
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
}
