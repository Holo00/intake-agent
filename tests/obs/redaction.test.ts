import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runIntake } from '@/lib/agent/run';
import { createStubProvider, withFault, type FaultName } from '@/lib/providers';
import { setLogSink, type LogRecord } from '@/lib/obs/log';
import { resetRunLog } from '@/lib/obs/run-log';

/**
 * Proof, not assertion.
 *
 * Redacting logs is a claim every codebase makes and few check. This runs a
 * real document through the whole pipeline, captures everything written to the
 * log sink, and searches it for the values that were extracted. If any of them
 * appears, the test fails.
 *
 * The value is in what it catches later: someone adds a `log.info('...', {
 * record })` while debugging, and CI rejects it. A convention would not.
 */

const NOW = new Date('2026-08-13T00:00:00Z');

/**
 * Every value on the clean specimen that must never reach a log.
 *
 * `managerName` leads the list deliberately: it is the one field that names a
 * private individual rather than a company, so it is the value whose escape
 * would matter most. A real UAE licence prints exactly this — the DIEZ format
 * has a "Company Manager / إسم مدير الشركة" block — which is why the schema
 * carries it and why it is tested here rather than assumed.
 */
const SECRETS = [
  'Yousef Abdulrahman Al Marzooqi',
  'يوسف عبدالرحمن المرزوقي',
  '784512',
  'Al Maha Logistics Solutions L.L.C',
  'الماها لحلول الخدمات اللوجستية ذ.م.م',
  'Office 1204, Al Shafar Tower, Al Barsha 1, Dubai',
  'Land Freight Transport Services',
  '2026-01-15',
  '2027-01-14',
];

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  resetRunLog();
});

async function captureLogs(id: string, fault?: FaultName): Promise<string> {
  const captured: LogRecord[] = [];
  restore = setLogSink((record) => captured.push(record));

  const stub = createStubProvider();

  await runIntake({
    provider: fault ? withFault(stub, fault) : stub,
    document: {
      bytes: await readFile(new URL(`../../public/samples/${id}.pdf`, import.meta.url)),
      mime: 'application/pdf',
    },
    requestId: 'redaction-test',
    now: NOW,
  });

  return JSON.stringify(captured);
}

describe('logging a successful extraction', () => {
  it('writes no extracted field value to the log', async () => {
    const output = await captureLogs('clean');

    for (const secret of SECRETS) {
      expect(output, `"${secret}" reached the log`).not.toContain(secret);
    }
  });

  it('still logs enough to debug with', async () => {
    const output = await captureLogs('clean');

    // Field *names* and issue codes are safe and are what you actually need.
    expect(output).toContain('intake.completed');
    expect(output).toContain('licenceNumber');
    expect(output).toContain('documentSha256');
  });
});

describe('logging a correction', () => {
  it('writes no field value even when reporting what failed', async () => {
    const output = await captureLogs('clean', 'join_activities');

    for (const secret of SECRETS) {
      expect(output, `"${secret}" reached the log`).not.toContain(secret);
    }

    // The failure itself must still be visible, or the redaction has cost us
    // the ability to debug — which is the trade this design exists to avoid.
    expect(output).toContain('ACTIVITIES_NOT_SPLIT');
    expect(output).toContain('"attempts":2');
  });
});
