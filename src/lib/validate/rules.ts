import type { TradeLicence } from '@/lib/schema/trade-licence';
import type { Issue } from './issue';

/**
 * Cross-field rules for a UAE trade licence.
 *
 * Every rule is a pure function of (record, context) so each one is a two-line
 * test with no network, no clock and no model. `now` is injected rather than
 * read from `Date` for exactly that reason — a rule about expiry that cannot be
 * tested at a fixed date is a rule nobody trusts.
 */

export interface RuleContext {
  now: Date;
}

type Rule = (record: TradeLicence, ctx: RuleContext) => Issue[];

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** UAE federation predates any valid licence; anything earlier is a misread year. */
const EARLIEST_PLAUSIBLE = new Date('1971-12-02');

/** Licences run 1–5 years. Beyond that, one of the two dates was misread. */
const MAX_TERM_YEARS = 5;

function parseDate(value: string): Date | null {
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Dates that parse individually but cannot both be true.
 *
 * Note this is an `extraction` issue, not a `document` one: a licence whose
 * expiry precedes its issue date does not exist in the wild, so the model
 * transposed something — most often by reading the Arabic column, which runs
 * right-to-left, in left-to-right order.
 */
const expiryAfterIssue: Rule = (record) => {
  const issue = parseDate(record.issueDate);
  const expiry = parseDate(record.expiryDate);
  if (!issue || !expiry) return [];
  if (expiry.getTime() > issue.getTime()) return [];

  return [
    {
      code: 'EXPIRY_NOT_AFTER_ISSUE',
      kind: 'extraction',
      severity: 'error',
      path: 'expiryDate',
      message: `Expiry date (${record.expiryDate}) is not after the issue date (${record.issueDate}).`,
      hint: 'Re-read both dates from the document. Check you have not swapped them, and remember UAE licences print dates day-first (DD/MM/YYYY).',
    },
  ];
};

/**
 * The licence is genuinely out of date.
 *
 * This is the rule the whole `kind` distinction exists for. It is a true
 * finding about the document, so it is reported and never retried — asking the
 * model to look again would either waste a call or, worse, pressure it into
 * inventing a date that passes.
 */
const notExpired: Rule = (record, ctx) => {
  const expiry = parseDate(record.expiryDate);
  if (!expiry) return [];
  if (expiry.getTime() >= ctx.now.getTime()) return [];

  return [
    {
      code: 'LICENCE_EXPIRED',
      kind: 'document',
      severity: 'error',
      path: 'expiryDate',
      message: `Licence expired on ${record.expiryDate} (${daysBetween(expiry, ctx.now)} days ago). Route to a human reviewer; do not auto-approve.`,
    },
  ];
};

const plausibleDates: Rule = (record, ctx) => {
  const issues: Issue[] = [];
  const issue = parseDate(record.issueDate);
  const expiry = parseDate(record.expiryDate);

  if (issue && issue.getTime() < EARLIEST_PLAUSIBLE.getTime()) {
    issues.push({
      code: 'ISSUE_DATE_IMPLAUSIBLE',
      kind: 'extraction',
      severity: 'error',
      path: 'issueDate',
      message: `Issue date ${record.issueDate} predates the formation of the UAE.`,
      hint: 'The year is wrong. Re-read the issue date, and check you have not read a Hijri (AH) date as Gregorian.',
    });
  }

  if (issue && expiry) {
    const termDays = daysBetween(issue, expiry);
    if (termDays > MAX_TERM_YEARS * 366) {
      issues.push({
        code: 'TERM_IMPLAUSIBLE',
        kind: 'extraction',
        severity: 'warning',
        path: 'expiryDate',
        message: `Licence term of ${Math.round(termDays / 365)} years is longer than any standard UAE licence.`,
        hint: 'Re-read both dates; one of the two years is likely misread.',
      });
    }
  }

  const established = record.establishmentDate ? parseDate(record.establishmentDate) : null;
  if (established && issue && established.getTime() > issue.getTime()) {
    issues.push({
      code: 'ESTABLISHED_AFTER_ISSUE',
      kind: 'extraction',
      severity: 'warning',
      path: 'establishmentDate',
      message: `Establishment date (${record.establishmentDate}) is after the issue date (${record.issueDate}).`,
      hint: 'The establishment date cannot follow the issue date. Check whether these two fields were swapped.',
    });
  }

  // Future-dated issue is checked last so its message can reference `now`.
  if (issue && issue.getTime() > ctx.now.getTime()) {
    issues.push({
      code: 'ISSUE_DATE_IN_FUTURE',
      kind: 'extraction',
      severity: 'error',
      path: 'issueDate',
      message: `Issue date ${record.issueDate} is in the future.`,
      hint: 'Re-read the issue date. A day-first date (DD/MM/YYYY) read as month-first is the usual cause.',
    });
  }

  return issues;
};

/**
 * Licence number shape.
 *
 * Formats vary widely between the seven emirates and the free zones, so this
 * deliberately checks only what is true everywhere — it is a warning, never an
 * error. A false rejection of a valid number is far more damaging than letting
 * an odd one through to a human.
 */
const licenceNumberShape: Rule = (record) => {
  const raw = record.licenceNumber.trim();
  const digits = (raw.match(/\d/g) ?? []).length;

  if (digits >= 4 && /^[A-Za-z0-9\-/ ]+$/.test(raw)) return [];

  return [
    {
      code: 'LICENCE_NUMBER_SHAPE',
      kind: 'extraction',
      severity: 'warning',
      path: 'licenceNumber',
      message: `"${raw}" does not look like a UAE licence number (expected at least 4 digits, letters/digits/dashes only).`,
      hint: 'Re-read the licence number. Return only the number itself — no label, no Arabic text, and none of the surrounding punctuation.',
    },
  ];
};

/**
 * Activities must arrive as a list.
 *
 * Models reliably return the activity block as one joined string, which is
 * useless to anything downstream that needs to match on an activity. Detecting
 * it is easy and the correction almost always lands on the retry.
 */
const activitiesSplit: Rule = (record) => {
  if (record.activities.length === 0) {
    return [
      {
        code: 'ACTIVITIES_EMPTY',
        kind: 'extraction',
        severity: 'warning',
        path: 'activities',
        message: 'No licensed activities were extracted.',
        hint: 'Trade licences almost always list at least one activity. Look for a numbered or bulleted block, often headed "Activities" or الأنشطة.',
      },
    ];
  }

  const looksJoined = (s: string) =>
    /\s\d+\s*[.)-]\s/.test(s) || (s.split(/[,;]/).length > 2 && s.length > 80);

  return record.activities.flatMap((activity, index) =>
    looksJoined(activity)
      ? [
          {
            code: 'ACTIVITIES_NOT_SPLIT',
            kind: 'extraction' as const,
            severity: 'error' as const,
            path: `activities.${index}`,
            message: 'Multiple activities appear to be joined into a single entry.',
            hint: 'Split the activity block into one array entry per activity. Drop the list numbering itself — the array index carries that.',
          },
        ]
      : [],
  );
};

/**
 * The Arabic name must actually be Arabic.
 *
 * A model asked for a bilingual field will happily transliterate the English
 * name rather than admit the Arabic is not legible. That failure is invisible
 * to anyone who does not read Arabic, which is precisely why it is worth a rule.
 */
const arabicNameIsArabic: Rule = (record) => {
  const fields = [
    ['legalNameAr', record.legalNameAr],
    ['tradeNameAr', record.tradeNameAr],
  ] as const;

  return fields.flatMap(([path, value]) =>
    value !== null && !ARABIC_SCRIPT.test(value)
      ? [
          {
            code: 'ARABIC_NAME_NOT_ARABIC',
            kind: 'extraction' as const,
            severity: 'error' as const,
            path,
            message: `The ${path} field contains no Arabic script.`,
            hint: 'Return the Arabic name exactly as printed on the page, in Arabic script. If no Arabic name is printed, return null — do not transliterate the English name.',
          },
        ]
      : [],
  );
};

const RULES: readonly Rule[] = [
  expiryAfterIssue,
  notExpired,
  plausibleDates,
  licenceNumberShape,
  activitiesSplit,
  arabicNameIsArabic,
];

/** Apply every rule. Order of the returned issues is stable across runs. */
export function applyRules(record: TradeLicence, ctx: RuleContext): Issue[] {
  return RULES.flatMap((rule) => rule(record, ctx));
}
