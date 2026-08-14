import { documentTypeLabel } from '@/lib/schema/trade-licence';

/**
 * The task description sent alongside the document.
 *
 * Deliberately short. The field-level guidance lives in `.describe()` on the
 * schema, which reaches the model as JSON Schema descriptions attached to the
 * exact field they govern — a far more reliable place for it than a paragraph
 * of prose the model has to map back onto field names itself.
 *
 * What stays here is only what is genuinely global: what the document is, how
 * to handle the bilingual layout, and the standing instruction not to guess.
 */
export const extractionInstructions = [
  `You are reading a ${documentTypeLabel}. Extract the fields defined by the response schema.`,
  '',
  'How to read this document:',
  '- It is bilingual. English runs left-to-right and Arabic right-to-left, often as parallel columns with the Arabic label on the far right of each row. Match each value to its own label, not to whatever is nearest on the page.',
  '- Dates are printed day-first (DD/MM/YYYY). Return them as YYYY-MM-DD.',
  '- Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) may appear alongside Western ones. They are the same values; return Western digits.',
  '- Seals and stamps are often printed over the text. Read what is underneath where you can.',
  '',
  'Rules:',
  '- Transcribe what is printed. Do not infer, complete or tidy up a value.',
  '- Where the schema permits null and the document does not show the field, return null. A null is a correct answer; a plausible invention is not.',
].join('\n');
