import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runIntake } from '@/lib/agent/run';
import { config } from '@/lib/config';
import { IntakeError, isIntakeError } from '@/lib/errors';
import { log } from '@/lib/obs/log';
import { getProvider, isFaultName, withFault } from '@/lib/providers';

/** node:crypto and Buffer, and the SDK is not edge-safe. */
export const runtime = 'nodejs';

/**
 * Accepted input types.
 *
 * An allowlist rather than a blocklist, and checked before the bytes go
 * anywhere near the model — an unexpected type is a cheap rejection here and an
 * expensive, unpredictable one downstream.
 */
const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = randomUUID();

  try {
    const form = await readForm(request);
    const document = await toDocument(readDocument(form));

    // Optional, explicit, and off by default — see src/lib/providers/fault.ts.
    const requested = form.get('fault');
    const provider = isFaultName(requested)
      ? withFault(getProvider(), requested)
      : getProvider();

    const result = await runIntake({ provider, document, requestId });

    return NextResponse.json({ requestId, ...result }, { headers: { 'x-request-id': requestId } });
  } catch (cause) {
    const error = isIntakeError(cause)
      ? cause
      : new IntakeError('INTERNAL', 'Something went wrong processing the document.', { cause });

    log.error('intake.request_failed', {
      requestId,
      code: error.code,
      status: error.status,
      detail: error.logDetail(),
    });

    return NextResponse.json(
      { requestId, error: error.toPublic() },
      { status: error.status, headers: { 'x-request-id': requestId } },
    );
  }
}

async function readForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    throw new IntakeError('NO_DOCUMENT', 'Send the document as multipart/form-data.');
  }
  return request.formData();
}

function readDocument(form: FormData) {
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new IntakeError('NO_DOCUMENT', 'No file was included under the field name "file".');
  }

  if (file.size === 0) {
    throw new IntakeError('NO_DOCUMENT', 'The uploaded file is empty.');
  }

  if (file.size > config.MAX_UPLOAD_BYTES) {
    throw new IntakeError(
      'PAYLOAD_TOO_LARGE',
      `File is ${(file.size / 1_048_576).toFixed(1)}MB; the limit is ${(config.MAX_UPLOAD_BYTES / 1_048_576).toFixed(0)}MB.`,
    );
  }

  const mime = file.type || 'application/octet-stream';
  if (!ACCEPTED_MIME.has(mime)) {
    throw new IntakeError(
      'UNSUPPORTED_MEDIA_TYPE',
      `${mime} is not supported. Send a PDF, PNG, JPEG or WebP.`,
    );
  }

  return { file, mime };
}

async function toDocument({ file, mime }: { file: File; mime: string }) {
  return { bytes: Buffer.from(await file.arrayBuffer()), mime };
}
