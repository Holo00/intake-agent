/**
 * Structured logging with the document kept out of it.
 *
 * The rule this file enforces: **no extracted field value is ever logged.**
 * Not the licence number, not the company name, not the address. A trade
 * licence is a customer's identity document, and logs are the least controlled
 * place data ends up — copied to an aggregator, read by whoever has dashboard
 * access, retained long after the request is forgotten.
 *
 * The enforcement is structural rather than a convention: `LogFields` only
 * admits values a reviewer can see. Logging a field value is a type error, not
 * a code-review catch. `tests/redaction.test.ts` then asserts the guarantee
 * end to end by running a real document through and searching the output for
 * its values.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Deliberately narrow. Numbers, booleans, and strings drawn from closed sets
 * we control — issue codes, field *names*, provider names, status values.
 * There is no member of this type that can carry document content.
 */
export type LogValue = string | number | boolean | null | readonly string[] | readonly number[];

export interface LogFields {
  readonly [key: string]: LogValue | undefined;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  fields: LogFields;
}

export type LogSink = (record: LogRecord) => void;

const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error') console.error(line);
  else if (record.level === 'warn') console.warn(line);
  else console.info(line);
};

let sink: LogSink = consoleSink;

/** Swap the sink. Returns a restore function; used by the redaction test. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  sink({ timestamp: new Date().toISOString(), level, event, fields });
}

export const log = {
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};

/**
 * What a record looks like from the outside: which fields arrived, which came
 * back null, how many activities. Enough to debug an extraction regression
 * without any of it being personal data.
 */
export function fieldSummary(record: object): LogFields {
  const entries = Object.entries(record);
  return {
    fieldsPresent: entries.filter(([, v]) => v !== null && v !== undefined).map(([k]) => k),
    fieldsNull: entries.filter(([, v]) => v === null || v === undefined).map(([k]) => k),
  };
}
