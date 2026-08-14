import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from '../types';

/**
 * Fault injection for the correction loop.
 *
 * Why this exists: a current frontier model reads these specimens correctly,
 * including a skewed, glare-lit, JPEG-mangled photograph of one. That is the
 * right outcome and I am not going to engineer a document to defeat it — a demo
 * that depends on tricking a model into failing is a demo that stops working
 * the week the model improves.
 *
 * But a correction loop that never runs is a correction loop nobody should
 * believe in. So the failure is injected deliberately and labelled as such: the
 * first attempt's output is corrupted on the way back from the *real* provider.
 * Everything downstream is genuine — real validation, real hints, a real second
 * call to the model, and a real corrected record.
 *
 * The faults are drawn from misreads I have actually seen in production, not
 * invented to suit the rules.
 *
 * This is also the provider interface paying for itself a second time: fault
 * injection is a decorator over `ExtractionProvider`, so nothing above it — not
 * the loop, not the route — knows it exists.
 */
export const FAULTS = {
  join_activities: {
    label: 'Activity list returned as one string',
    detail:
      'The commonest structural miss: a numbered activity block comes back joined into a single entry instead of one per activity.',
    apply: (record: Record<string, unknown>) => {
      const activities = record.activities;
      if (!Array.isArray(activities) || activities.length === 0) return record;
      return {
        ...record,
        activities: [activities.map((a, i) => `${i + 1}. ${String(a)}`).join(' ')],
      };
    },
  },

  swap_dates: {
    label: 'Issue and expiry dates transposed',
    detail:
      'Reading a right-to-left column left-to-right, or a day-first date as month-first. Produces an expiry that precedes its issue date.',
    apply: (record: Record<string, unknown>) => ({
      ...record,
      issueDate: record.expiryDate,
      expiryDate: record.issueDate,
    }),
  },

  transliterate_arabic: {
    label: 'Arabic name transliterated instead of transcribed',
    detail:
      'Where the Arabic is hard to read, a model will often romanise the English name rather than return null. Invisible to a reviewer who does not read Arabic.',
    apply: (record: Record<string, unknown>) => ({
      ...record,
      tradeNameAr: typeof record.tradeNameEn === 'string' ? record.tradeNameEn : record.tradeNameAr,
    }),
  },
} as const;

export type FaultName = keyof typeof FAULTS;

export function isFaultName(value: unknown): value is FaultName {
  return typeof value === 'string' && value in FAULTS;
}

/**
 * Wraps a provider so the *first* attempt returns corrupted output.
 *
 * Only the first: the correction attempt has to be able to succeed, or the
 * demonstration is of an infinite loop rather than a recovery. Attempts after
 * the first are identified by the presence of validation feedback.
 */
export function withFault(provider: ExtractionProvider, fault: FaultName): ExtractionProvider {
  return {
    name: `${provider.name}+fault:${fault}`,

    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      const response = await provider.extract(request);

      if (request.feedback) return response;
      if (typeof response.raw !== 'object' || response.raw === null) return response;

      return { ...response, raw: FAULTS[fault].apply(response.raw as Record<string, unknown>) };
    },
  };
}
