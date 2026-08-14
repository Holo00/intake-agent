import { config, type Config } from '@/lib/config';
import { createGeminiProvider } from './gemini';
import { createStubProvider } from './stub';
import { withRetry } from './decorators/retry';
import type { ExtractionProvider } from './types';

export type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResponse,
  DocumentInput,
  TokenUsage,
} from './types';
export { createStubProvider, fixtureResolver } from './stub';
export { withFault, isFaultName, FAULTS, type FaultName } from './decorators/fault';
export { withRetry, type RetryOptions } from './decorators/retry';

/**
 * The only place a provider is chosen.
 *
 * Adding one is a new file implementing `ExtractionProvider` plus a case here.
 * Nothing above this line — not the extraction service, not the agent loop, not
 * the route — imports a vendor SDK.
 */
function build(cfg: Config): ExtractionProvider {
  switch (cfg.provider) {
    case 'gemini':
      // Presence of the key is guaranteed by the boot-time check in config.ts.
      // Transient-failure retry wraps the adapter, so a 429 costs the run some
      // latency rather than one of its two correction attempts.
      return withRetry(createGeminiProvider(cfg.GEMINI_API_KEY!, cfg.GEMINI_MODEL), {
        maxRetries: cfg.PROVIDER_MAX_RETRIES,
        baseDelayMs: cfg.PROVIDER_RETRY_BASE_MS,
      });
    case 'stub':
      return createStubProvider();
  }
}

let instance: ExtractionProvider | null = null;

export function getProvider(): ExtractionProvider {
  instance ??= build(config);
  return instance;
}
