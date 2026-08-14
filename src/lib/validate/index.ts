import type { $ZodIssue } from 'zod/v4/core';
import { tradeLicenceSchema, type TradeLicence } from '@/lib/schema/trade-licence';
import type { Issue } from './issue';
import { applyRules, type RuleContext } from './rules';

export type { Issue, IssueKind, IssueSeverity } from './issue';
export { retryable, isClean } from './issue';

export type ValidationResult =
  | { ok: true; record: TradeLicence; issues: Issue[] }
  | { ok: false; record: null; issues: Issue[] };

/**
 * Two passes, in order, because they answer different questions.
 *
 * Structural (Zod): is this the right *shape*? A missing field or a date in the
 * wrong format fails here, and there is no typed record to run rules against.
 *
 * Semantic (rules): given a well-shaped record, is it *coherent* — and is the
 * licence itself in good standing? This is where the domain lives.
 *
 * Both emit the same `Issue` type, so the agent loop feeds either kind back to
 * the model without caring which pass produced it.
 */
export function validate(raw: unknown, ctx: RuleContext): ValidationResult {
  const parsed = tradeLicenceSchema.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, record: null, issues: parsed.error.issues.map(toIssue) };
  }

  return { ok: true, record: parsed.data, issues: applyRules(parsed.data, ctx) };
}

/**
 * A schema violation is always an extraction fault: the model was handed this
 * exact schema as its output contract, so anything off-contract is the model's
 * miss and re-reading is a reasonable thing to ask of it.
 */
function toIssue(issue: $ZodIssue): Issue {
  const path = issue.path.join('.');
  return {
    code: `SCHEMA_${issue.code.toUpperCase()}`,
    kind: 'extraction',
    severity: 'error',
    path,
    message: path ? `${path}: ${issue.message}` : issue.message,
    hint: hintFor(issue, path),
  };
}

function hintFor(issue: $ZodIssue, path: string): string {
  const field = path || 'the record';
  switch (issue.code) {
    case 'invalid_type':
      return `${field} must be a ${issue.expected}. Return the value in that type rather than as a string containing it.`;
    case 'invalid_format':
      return `${field} does not match the required format. ${issue.message}`;
    case 'unrecognized_keys':
      return `Return only the fields defined in the schema. Unexpected: ${issue.keys.join(', ')}.`;
    default:
      return `Correct ${field}: ${issue.message}`;
  }
}
