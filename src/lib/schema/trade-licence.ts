import { z } from 'zod';

/**
 * The one place a trade-licence field is declared.
 *
 * This single schema produces three things that would otherwise drift apart:
 *   1. the JSON Schema handed to the model as its output contract
 *   2. the runtime validator applied to whatever comes back
 *   3. the TypeScript type used everywhere downstream
 *
 * Supporting a second document type means adding a sibling file, not editing
 * the extraction service, the loop, or the route.
 *
 * `.describe()` is not documentation. It is shipped to the model as the field
 * description inside the JSON Schema, so it is the highest-leverage prompt
 * surface in the codebase — the place to encode what the label looks like on a
 * real licence, in both languages.
 */

/** ISO 8601 calendar date. Kept as a string: a Date here would hide the very
 *  malformations the validation layer exists to catch. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format');

export const tradeLicenceSchema = z.object({
  licenceNumber: z
    .string()
    .describe(
      'The trade licence number, printed near the top. Labelled "License No." / "Licence Number" / رقم الرخصة. Digits, sometimes with a CN/ or a dash prefix. Copy it exactly as printed.',
    ),

  legalNameEn: z
    .string()
    .describe(
      'The entity holding the licence, in English, including its legal form. Labelled "License", "Licensee", "Trade Name" or صاحب الرخصة depending on the issuer. Where the document shows both a licence holder and a separate trade name, this is the holder.',
    ),

  legalNameAr: z
    .string()
    .nullable()
    .describe(
      'The same entity name in Arabic, if present on the document. Null if the licence is English-only. Do not transliterate the English name — return only Arabic actually printed on the page.',
    ),

  /**
   * Free-zone licences routinely print the licence holder and the trading name
   * as two separate fields. They are often identical and sometimes are not, and
   * a pipeline that collapses them loses that distinction silently.
   */
  tradeNameEn: z
    .string()
    .nullable()
    .describe(
      'The trading name (الاسم التجاري) where the document shows it as a field distinct from the licence holder. Return it even when it matches the holder exactly — transcribe what is printed. Null only when the document has no such field.',
    ),

  tradeNameAr: z
    .string()
    .nullable()
    .describe('The trading name in Arabic, where printed. Null otherwise. Never a transliteration.'),

  legalForm: z
    .string()
    .nullable()
    .describe(
      'The legal form where stated as its own field — "Limited Liability Company", "FZCO", "FZE", "FZ-LLC", "Sole Establishment", "Free Zone Establishment". Some issuers label this "Legal Status". Null if only embedded in the name.',
    ),

  /**
   * A named private individual, and the only field here that identifies a
   * person rather than a company. It is the reason the redaction guarantee in
   * `obs/log.ts` is enforced by the type system rather than by convention.
   */
  managerName: z
    .string()
    .nullable()
    .describe(
      'The manager or authorised signatory named on the licence, under a heading such as "Company Manager", "Name of Manager", "General Manager" or مدير الشركة. Null when the document names no manager.',
    ),

  issuingAuthority: z
    .string()
    .describe(
      'The authority that issued the licence, e.g. "Department of Economic Development - Dubai", "Abu Dhabi Department of Economic Development", or a free-zone authority such as "DMCC" or "SHAMS".',
    ),

  emirate: z
    .enum(['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'])
    .nullable()
    .describe(
      'The emirate the licence is issued in. Infer from the issuing authority or the address when not stated outright. Null if genuinely undeterminable.',
    ),

  issueDate: isoDate
    .describe(
      'Date of issue (تاريخ الإصدار), normalised to YYYY-MM-DD. Source documents commonly use DD/MM/YYYY — UAE licences are day-first, so 03/04/2024 is 2024-04-03.',
    ),

  expiryDate: isoDate
    .describe(
      'Date of expiry (تاريخ الانتهاء), normalised to YYYY-MM-DD. Same day-first convention as the issue date.',
    ),

  establishmentDate: isoDate
    .nullable()
    .describe('Original establishment/registration date if shown separately from the issue date. Null if absent.'),

  activities: z
    .array(z.string())
    .describe(
      'Licensed business activities, one string per activity. These are printed as a numbered or bulleted list and must be split into separate entries — never returned as a single joined string. Empty array only if the licence genuinely lists none.',
    ),

  registeredAddress: z
    .string()
    .nullable()
    .describe('Registered address or premises as printed. Null if absent.'),
});

export type TradeLicence = z.infer<typeof tradeLicenceSchema>;

/** The output contract sent to the model. Derived, never hand-written. */
export const tradeLicenceJsonSchema = z.toJSONSchema(tradeLicenceSchema);

export const documentTypeLabel = 'UAE trade licence';
