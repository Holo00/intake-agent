import { createHash } from 'node:crypto';
import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type GenerateContentRequest,
} from '@google/generative-ai';
import { IntakeError } from '@/lib/errors';
import { toGeminiSchema } from './schema';
import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from '../types';

/**
 * Clients are cached and reused. Constructing `GoogleGenerativeAI` per request
 * is cheap but not free, and in a serverless runtime the module scope survives
 * between invocations on a warm instance — so this is the difference between
 * building it once and building it on every upload.
 *
 * The response schema is baked into the model at construction, so it has to be
 * part of the cache key. Keying on the model name alone would mean a second
 * document type silently reusing the first one's output contract.
 */
const clients = new Map<string, GenerativeModel>();

function getModel(apiKey: string, modelName: string, schema: object): GenerativeModel {
  const cacheKey = `${modelName}:${createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 16)}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
      // Extraction is a transcription task, not a creative one. Anything above
      // zero trades accuracy for variety, which is the wrong trade here.
      temperature: 0,
    },
  });

  clients.set(cacheKey, model);
  return model;
}

export function createGeminiProvider(apiKey: string, modelName: string): ExtractionProvider {
  return {
    name: `gemini:${modelName}`,

    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      const model = getModel(apiKey, modelName, request.jsonSchema);

      const payload: GenerateContentRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: request.document.mime,
                  data: request.document.bytes.toString('base64'),
                },
              },
              { text: buildPrompt(request) },
            ],
          },
        ],
      };

      const result = await withAbort(
        model.generateContent(payload),
        request.signal,
      );

      const text = result.response.text();
      const usage = result.response.usageMetadata;

      return {
        raw: parseJson(text),
        model: modelName,
        usage: {
          input: usage?.promptTokenCount ?? 0,
          output: usage?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}

function buildPrompt(request: ExtractionRequest): string {
  const base = request.instructions;
  if (!request.feedback) return base;

  // The correction attempt gets the model's own previous answer plus the
  // specific complaints against it. Restating the whole task as well matters:
  // a bare list of corrections tends to produce a patch of those fields with
  // the rest of the record quietly dropped.
  const complaints = request.feedback.issues
    .map((i) => `- ${i.path || '(record)'}: ${i.hint ?? i.message}`)
    .join('\n');

  return [
    base,
    '',
    'Your previous answer failed validation.',
    '',
    'Previous answer:',
    JSON.stringify(request.feedback.previous, null, 2),
    '',
    'Problems found:',
    complaints,
    '',
    'Read the document again and return the complete corrected record. Include every field, not only the corrected ones.',
  ].join('\n');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    // `responseMimeType: application/json` makes this rare, but "rare" and
    // "never" need different code.
    throw new IntakeError('PROVIDER_BAD_RESPONSE', 'Model returned output that is not valid JSON.', {
      cause,
    });
  }
}

/**
 * The SDK accepts a `timeout` but no external `AbortSignal`, so a caller cannot
 * cancel a call already in flight. Racing the promise against the signal gives
 * us back that control — which is what lets the agent loop bound its *total*
 * time rather than only each attempt.
 *
 * Worth being precise about what this does and does not do: it stops us waiting
 * on the response. The underlying HTTP request is not cancelled and the tokens
 * are still billed. Nothing in the SDK's surface allows better.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new IntakeError('PROVIDER_TIMEOUT', 'Extraction timed out.'));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new IntakeError('PROVIDER_TIMEOUT', 'Extraction timed out.'));

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(resolve, (cause) => reject(mapError(cause))).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Google's SDK reports everything as a message string, so status matching is
 * the only option available. Kept in one place so the rest of the codebase
 * never has to know that.
 */
function mapError(cause: unknown): IntakeError {
  if (cause instanceof IntakeError) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);

  if (/\[429/.test(message) || /quota|rate limit/i.test(message)) {
    return new IntakeError('PROVIDER_RATE_LIMITED', 'Model provider rate limit reached.', { cause });
  }
  if (/\[40[13]/.test(message) || /api key|permission/i.test(message)) {
    return new IntakeError('PROVIDER_AUTH', 'Model provider rejected our credentials.', { cause });
  }
  // A 404 means the configured model does not exist — usually because it was
  // retired. That is a deployment fault, not a transient outage, and marking it
  // transient would have us retry a call that can never succeed.
  if (/\[404/.test(message) || /no longer available|not found/i.test(message)) {
    return new IntakeError('PROVIDER_MODEL_UNAVAILABLE', 'The configured model is unavailable.', {
      cause,
    });
  }
  if (/\[5\d\d/.test(message) || /fetch failed|ECONNRESET|ENOTFOUND/i.test(message)) {
    return new IntakeError('PROVIDER_UNAVAILABLE', 'Model provider is unavailable.', { cause });
  }
  if (/safety|blocked|recitation/i.test(message)) {
    return new IntakeError('PROVIDER_CONTENT_BLOCKED', 'Model declined to process this document.', {
      cause,
    });
  }

  return new IntakeError('PROVIDER_UNAVAILABLE', 'Model provider call failed.', { cause });
}
