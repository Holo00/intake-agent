import { z } from 'zod';

/**
 * Environment is parsed once, at module load, and the process refuses to serve
 * requests with a broken config. The alternative — reading `process.env` at the
 * call site — turns a missing key into a 500 on the first upload, which is the
 * worst possible time to find out.
 */
/**
 * Treat a blank environment variable as absent.
 *
 * Deployment platforms — and `.env` files copied from an example — routinely
 * hand over an empty string for a variable nobody filled in. Two failures
 * follow if that is taken at face value, and this project hit both:
 *
 *   `GEMINI_API_KEY=` refused to boot even under `LLM_PROVIDER=stub`, because
 *   an empty string is *present* and `.optional()` does not save it.
 *
 *   `COST_INPUT_PER_MTOK=` coerced to `0`, which would have reported a
 *   configured token price of zero — a confident, wrong number, which is the
 *   exact failure the cost module refuses to produce.
 */
const blankAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema);

const envSchema = z.object({
  LLM_PROVIDER: blankAsUndefined(z.enum(['gemini', 'stub']).default('stub')),
  GEMINI_API_KEY: blankAsUndefined(z.string().min(1).optional()),
  GEMINI_MODEL: blankAsUndefined(z.string().default('gemini-3.6-flash')),

  /** Wall-clock ceiling for a single model call. The SDKs do not enforce one. */
  EXTRACTION_TIMEOUT_MS: blankAsUndefined(z.coerce.number().int().positive().default(45_000)),
  /** Attempts *including* the first. 2 = one initial pass, one correction. */
  MAX_ATTEMPTS: blankAsUndefined(z.coerce.number().int().min(1).max(5).default(2)),
  MAX_UPLOAD_BYTES: blankAsUndefined(z.coerce.number().int().positive().default(10 * 1024 * 1024)),

  /** Transient-failure retries (429/503/dropped connection), separate from the agent loop. */
  PROVIDER_MAX_RETRIES: blankAsUndefined(z.coerce.number().int().min(0).max(5).default(2)),
  PROVIDER_RETRY_BASE_MS: blankAsUndefined(z.coerce.number().int().positive().default(500)),

  /**
   * Token prices, USD per million tokens. Optional and deliberately unset by
   * default: a stale hardcoded rate produces confident, wrong money.
   */
  COST_INPUT_PER_MTOK: blankAsUndefined(z.coerce.number().nonnegative().optional()),
  COST_OUTPUT_PER_MTOK: blankAsUndefined(z.coerce.number().nonnegative().optional()),
});

export type Config = z.infer<typeof envSchema> & {
  provider: ProviderName;
  rates: { inputPerMTok: number; outputPerMTok: number } | null;
};
export type ProviderName = z.infer<typeof envSchema>['LLM_PROVIDER'];

function load(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const env = parsed.data;

  // A provider selected without its credential is a deploy mistake, not a
  // runtime condition. Fail here rather than on the reviewer's first upload.
  if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY to be set.');
  }

  // Half a price table is worse than none: it would report a plausible number
  // computed from one rate and a zero.
  const hasInput = env.COST_INPUT_PER_MTOK !== undefined;
  const hasOutput = env.COST_OUTPUT_PER_MTOK !== undefined;
  if (hasInput !== hasOutput) {
    throw new Error('Set both COST_INPUT_PER_MTOK and COST_OUTPUT_PER_MTOK, or neither.');
  }

  return {
    ...env,
    provider: env.LLM_PROVIDER,
    rates: hasInput
      ? { inputPerMTok: env.COST_INPUT_PER_MTOK!, outputPerMTok: env.COST_OUTPUT_PER_MTOK! }
      : null,
  };
}

export const config: Config = load();

/** Model name for the active provider, for display and logging. */
export function activeModel(cfg: Config = config): string {
  switch (cfg.provider) {
    case 'gemini':
      return cfg.GEMINI_MODEL;
    case 'stub':
      return 'stub';
  }
}
