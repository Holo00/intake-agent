import { describe, expect, it } from 'vitest';
import { applyRules } from '@/lib/validate/rules';
import type { TradeLicence } from '@/lib/schema/trade-licence';

/**
 * Rules are pure functions of (record, now), so every case here is a fixed
 * record at a fixed date. No network, no model, no clock.
 */

const NOW = new Date('2026-08-13T00:00:00Z');

const valid: TradeLicence = {
  isTradeLicence: true,
  licenceNumber: '784512',
  legalNameEn: 'Al Maha Logistics Solutions L.L.C',
  legalNameAr: 'الماها لحلول الخدمات اللوجستية ذ.م.م',
  tradeNameEn: null,
  tradeNameAr: null,
  legalForm: 'Limited Liability Company',
  managerName: 'Yousef Abdulrahman Al Marzooqi',
  issuingAuthority: 'Department of Economic Development - Dubai',
  emirate: 'Dubai',
  issueDate: '2026-01-15',
  expiryDate: '2027-01-14',
  establishmentDate: '2019-01-14',
  activities: ['Land Freight Transport Services', 'Warehousing and Storage Services'],
  registeredAddress: 'Office 1204, Al Shafar Tower, Al Barsha 1, Dubai',
};

const check = (overrides: Partial<TradeLicence> = {}) =>
  applyRules({ ...valid, ...overrides }, { now: NOW });

const codes = (overrides: Partial<TradeLicence> = {}) => check(overrides).map((i) => i.code);

describe('a well-formed, in-date licence', () => {
  it('raises no issues', () => {
    expect(check()).toEqual([]);
  });
});

describe('date coherence', () => {
  it('rejects an expiry that precedes the issue date', () => {
    expect(codes({ issueDate: '2026-06-01', expiryDate: '2026-01-01' })).toContain(
      'EXPIRY_NOT_AFTER_ISSUE',
    );
  });

  it('rejects an expiry equal to the issue date', () => {
    expect(codes({ issueDate: '2026-06-01', expiryDate: '2026-06-01' })).toContain(
      'EXPIRY_NOT_AFTER_ISSUE',
    );
  });

  it('treats a transposed pair as an extraction fault, so it can be retried', () => {
    const [issue] = check({ issueDate: '2026-06-01', expiryDate: '2026-01-01' });
    expect(issue?.kind).toBe('extraction');
    expect(issue?.hint).toBeDefined();
  });

  it('flags an issue date before the UAE existed', () => {
    expect(codes({ issueDate: '1965-01-01', expiryDate: '1966-01-01' })).toContain(
      'ISSUE_DATE_IMPLAUSIBLE',
    );
  });

  it('flags a future issue date', () => {
    expect(codes({ issueDate: '2027-01-01', expiryDate: '2027-12-31' })).toContain(
      'ISSUE_DATE_IN_FUTURE',
    );
  });

  it('warns on a term longer than any real licence', () => {
    expect(codes({ issueDate: '2026-01-15', expiryDate: '2036-01-14' })).toContain(
      'TERM_IMPLAUSIBLE',
    );
  });

  it('warns when establishment postdates issue', () => {
    expect(codes({ establishmentDate: '2026-06-01' })).toContain('ESTABLISHED_AFTER_ISSUE');
  });
});

describe('expiry is a fact about the document, not a misreading', () => {
  it('flags an expired licence', () => {
    expect(codes({ issueDate: '2023-06-01', expiryDate: '2024-05-31' })).toContain(
      'LICENCE_EXPIRED',
    );
  });

  it('marks it `document` kind with no hint, so the loop will not retry it', () => {
    const expired = check({ issueDate: '2023-06-01', expiryDate: '2024-05-31' }).find(
      (i) => i.code === 'LICENCE_EXPIRED',
    );
    expect(expired?.kind).toBe('document');
    expect(expired?.hint).toBeUndefined();
  });

  it('accepts a licence expiring today', () => {
    expect(codes({ issueDate: '2025-08-13', expiryDate: '2026-08-13' })).not.toContain(
      'LICENCE_EXPIRED',
    );
  });
});

describe('activities must arrive as a list', () => {
  it('detects a numbered block returned as one joined string', () => {
    expect(
      codes({
        activities: [
          '1. Electromechanical Equipment Installation 2. Air Conditioning Contracting 3. Plumbing and Sanitary Installation Contracting',
        ],
      }),
    ).toContain('ACTIVITIES_NOT_SPLIT');
  });

  it('detects a long comma-joined string', () => {
    expect(
      codes({
        activities: [
          'Land Freight Transport Services, Warehousing and Storage Services, Sea Freight Forwarding Brokers, Packaging Services',
        ],
      }),
    ).toContain('ACTIVITIES_NOT_SPLIT');
  });

  it('leaves a legitimately comma-bearing single activity alone', () => {
    expect(codes({ activities: ['Trading in building materials, tools and hardware'] })).toEqual([]);
  });

  it('warns on an empty list without failing the record', () => {
    const issues = check({ activities: [] });
    expect(issues.map((i) => i.code)).toContain('ACTIVITIES_EMPTY');
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('the Arabic name must be Arabic', () => {
  it('rejects a transliteration', () => {
    expect(codes({ legalNameAr: 'Al Maha Logistics Solutions' })).toContain(
      'ARABIC_NAME_NOT_ARABIC',
    );
  });

  it('accepts a genuine absence', () => {
    expect(codes({ legalNameAr: null })).toEqual([]);
  });

  it('checks the trade name as well as the legal name', () => {
    const issues = check({ tradeNameAr: 'Al Maha Logistics Solutions' });
    expect(issues.map((i) => i.code)).toContain('ARABIC_NAME_NOT_ARABIC');
    expect(issues[0]?.path).toBe('tradeNameAr');
  });

  it('reports both when both are transliterated', () => {
    const issues = check({ legalNameAr: 'Al Maha', tradeNameAr: 'Al Maha' });
    expect(issues.filter((i) => i.code === 'ARABIC_NAME_NOT_ARABIC')).toHaveLength(2);
  });
});

describe('licence number shape', () => {
  it('accepts a free-zone prefixed number', () => {
    expect(codes({ licenceNumber: 'SHAMS-11029' })).toEqual([]);
  });

  it('accepts an Abu Dhabi CN number', () => {
    expect(codes({ licenceNumber: 'CN-2094771' })).toEqual([]);
  });

  it('warns when the label came along with the number', () => {
    // A real miss: the model returns the whole cell rather than the value.
    const issues = check({ licenceNumber: 'License No. 784512' });
    expect(issues.map((i) => i.code)).toContain('LICENCE_NUMBER_SHAPE');
    expect(issues.find((i) => i.code === 'LICENCE_NUMBER_SHAPE')?.severity).toBe('warning');
  });

  it('warns on too few digits to be a licence number', () => {
    expect(codes({ licenceNumber: '12' })).toContain('LICENCE_NUMBER_SHAPE');
  });

  /**
   * Found by a live specimen whose number was illegible: the model correctly
   * returned "N/A" and the record passed as `valid`, because a warning does not
   * block. A record that cannot say which licence it describes is not fit to
   * auto-approve.
   */
  it('errors when there are no digits at all, so the record cannot auto-approve', () => {
    const issues = check({ licenceNumber: 'N/A' });
    const missing = issues.find((i) => i.code === 'LICENCE_NUMBER_MISSING');

    expect(missing?.severity).toBe('error');
    expect(missing?.kind).toBe('extraction');
    expect(issues.map((i) => i.code)).not.toContain('LICENCE_NUMBER_SHAPE');
  });

  it('hints against returning a placeholder, since that is what the model did', () => {
    expect(check({ licenceNumber: 'N/A' })[0]?.hint).toMatch(/never return a placeholder/i);
  });
});

describe('a document that is not a trade licence', () => {
  /**
   * The commonest thing an intake endpoint receives after the correct
   * document: a passport, an invoice, the blank back of a page.
   */
  const rejected = { isTradeLicence: false } as const;

  it('is rejected outright', () => {
    expect(codes(rejected)).toEqual(['NOT_A_TRADE_LICENCE']);
  });

  it('reports one clear reason rather than eleven symptoms of it', () => {
    // Everything null, as it would be for an invoice. Without the
    // short-circuit this would produce a wall of missing-field errors, and the
    // actual answer — wrong document — would be buried among them.
    const issues = check({
      ...rejected,
      licenceNumber: null,
      legalNameEn: null,
      issueDate: null,
      expiryDate: null,
      activities: [],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('NOT_A_TRADE_LICENCE');
  });

  it('is a `document` finding with no hint, so the loop will not retry it', () => {
    // Reading an invoice a second time does not turn it into a licence.
    const [issue] = check(rejected);
    expect(issue?.kind).toBe('document');
    expect(issue?.hint).toBeUndefined();
  });

  it('does not fire on a genuine licence', () => {
    expect(codes()).not.toContain('NOT_A_TRADE_LICENCE');
  });
});

describe('identity fields on a document that claims to be a licence', () => {
  it('errors when the licence number is absent entirely', () => {
    const issues = check({ licenceNumber: null });
    const missing = issues.find((i) => i.code === 'MISSING_REQUIRED_FIELD');

    expect(missing?.path).toBe('licenceNumber');
    expect(missing?.severity).toBe('error');
    // Extraction, not document: a seal over the header is worth a second look.
    expect(missing?.kind).toBe('extraction');
  });

  it('reports every missing identity field, not just the first', () => {
    const issues = check({ licenceNumber: null, legalNameEn: null, expiryDate: null });
    expect(issues.filter((i) => i.code === 'MISSING_REQUIRED_FIELD')).toHaveLength(3);
  });

  it('leaves genuinely optional fields alone when null', () => {
    expect(codes({ managerName: null, establishmentDate: null, registeredAddress: null })).toEqual(
      [],
    );
  });
});
