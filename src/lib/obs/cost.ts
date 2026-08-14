import type { TokenUsage } from '@/lib/providers/types';

/**
 * Token cost, when — and only when — rates have been configured.
 *
 * Model prices are configuration, not facts this codebase should assert. They
 * change, they differ by region and tier, and a hardcoded rate that silently
 * goes stale produces confident, wrong financial numbers, which is worse than
 * no number at all. So rates come from the environment and cost is simply
 * omitted when they are absent.
 *
 * The token counts and the correction *ratio* below need no rates at all, which
 * is deliberate: the operationally interesting figure survives even when nobody
 * has configured pricing.
 */
export interface Rates {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function estimateCost(usage: TokenUsage, rates: Rates | null): number | null {
  if (!rates) return null;
  return (usage.input * rates.inputPerMTok + usage.output * rates.outputPerMTok) / 1_000_000;
}

/**
 * What a correction actually costs, in tokens, as a multiple of the first read.
 *
 * This is the number that matters at volume, and it is consistently worse than
 * people expect. A correction attempt resends the entire document *plus* the
 * previous answer *plus* the validation errors, so attempt two is typically
 * more expensive than attempt one — the retry is not a cheap top-up.
 *
 * Budgeting an intake pipeline is therefore `correction rate × this multiple`,
 * not `correction rate × a bit`.
 */
export function correctionOverhead(
  attempts: readonly { usage: TokenUsage }[],
): { firstTokens: number; retryTokens: number; multiple: number | null } {
  const total = (u: TokenUsage) => u.input + u.output;

  const first = attempts[0] ? total(attempts[0].usage) : 0;
  const retry = attempts.slice(1).reduce((sum, a) => sum + total(a.usage), 0);

  return {
    firstTokens: first,
    retryTokens: retry,
    multiple: first > 0 && retry > 0 ? Number((retry / first).toFixed(2)) : null,
  };
}
