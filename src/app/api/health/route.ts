import { NextResponse } from 'next/server';
import { activeModel, config } from '@/lib/config';
import { getProvider } from '@/lib/providers';
import { metrics } from '@/lib/obs/metrics';
import { recentRuns } from '@/lib/obs/run-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness and operational metrics.
 *
 * A 200 that only proves the process is running tells you nothing you did not
 * already know from the request reaching it. This answers the questions you
 * actually ask at 2am: what is this instance talking to, what are its limits,
 * how often is it working, how slow is it, what is it costing, and which
 * validation rule is firing most.
 *
 * Nothing here is sensitive — no key, no key prefix, no field value. Recent
 * runs carry a document hash and issue codes only, which is what makes it safe
 * to expose without an auth layer this demo does not have.
 */
export function GET(): NextResponse {
  return NextResponse.json({
    status: 'ok',
    // Which build is actually serving. Without this, "is the fix deployed?"
    // is answered by guessing at response behaviour.
    version: {
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      branch: process.env.RAILWAY_GIT_BRANCH ?? 'local',
      deployedAt: process.env.RAILWAY_DEPLOYMENT_ID ? undefined : 'dev',
    },
    provider: getProvider().name,
    model: activeModel(),
    limits: {
      maxAttempts: config.MAX_ATTEMPTS,
      timeoutMs: config.EXTRACTION_TIMEOUT_MS,
      maxUploadBytes: config.MAX_UPLOAD_BYTES,
      providerMaxRetries: config.PROVIDER_MAX_RETRIES,
    },
    metrics: metrics(),
    recentRuns: recentRuns().slice(0, 10),
  });
}
