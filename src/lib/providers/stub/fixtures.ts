import type { TradeLicence } from '@/lib/schema/trade-licence';

/**
 * Canned model responses for the three synthetic samples.
 *
 * These drive `LLM_PROVIDER=stub`, which exists so the demo can be cloned and
 * run with no API key at all. The point is not to fake a good result — it is to
 * let the loop, the rules and the UI run end to end deterministically, so the
 * whole thing is reviewable in thirty seconds and testable in CI.
 *
 * `firstPass` is what the model actually tends to return for each specimen;
 * `corrected` is what it returns once the validation issues are handed back.
 * Where `corrected` is absent, no retry should happen — either the first pass
 * was clean, or the problem is with the licence rather than the reading of it.
 */
export interface StubFixture {
  firstPass: unknown;
  corrected?: unknown;
}

const clean: TradeLicence = {
  licenceNumber: '784512',
  legalNameEn: 'Al Maha Logistics Solutions L.L.C',
  legalNameAr: 'الماها لحلول الخدمات اللوجستية ذ.م.م',
  tradeNameEn: 'Al Maha Logistics Solutions L.L.C',
  tradeNameAr: 'الماها لحلول الخدمات اللوجستية ذ.م.م',
  legalForm: 'Limited Liability Company',
  managerName: 'Yousef Abdulrahman Al Marzooqi',
  issuingAuthority: 'Department of Economic Development - Dubai',
  emirate: 'Dubai',
  issueDate: '2026-01-15',
  expiryDate: '2027-01-14',
  establishmentDate: '2019-01-14',
  activities: [
    'Land Freight Transport Services',
    'Warehousing and Storage Services',
    'Sea Freight Forwarding Brokers',
    'Packaging Services',
  ],
  registeredAddress: 'Office 1204, Al Shafar Tower, Al Barsha 1, Dubai',
};

const expired: TradeLicence = {
  licenceNumber: 'SHAMS-11029',
  legalNameEn: 'Gulf Horizon Trading FZE',
  legalNameAr: 'أفق الخليج للتجارة',
  tradeNameEn: 'Gulf Horizon Trading FZE',
  tradeNameAr: 'أفق الخليج للتجارة',
  legalForm: 'Free Zone Establishment',
  managerName: 'Fatima Hassan Al Balushi',
  issuingAuthority: 'Sharjah Media City Free Zone Authority (SHAMS)',
  emirate: 'Sharjah',
  issueDate: '2023-06-01',
  expiryDate: '2024-05-31',
  establishmentDate: '2021-06-01',
  activities: ['General Trading', 'Building Materials Trading', 'Import and Export'],
  registeredAddress: 'Business Centre, Al Messaned, Sharjah Media City, Sharjah',
};

const awkwardActivities = [
  'Electromechanical Equipment Installation and Maintenance',
  'Air Conditioning and Ventilation Systems Contracting',
  'Plumbing and Sanitary Installation Contracting',
  'Electrical Fittings and Fixtures Installation',
  'Building Cleaning Services',
  'Swimming Pool Installation and Maintenance',
];

const awkwardBase: TradeLicence = {
  licenceNumber: 'CN-2094771',
  legalNameEn: 'Nakheel Technical Services L.L.C',
  legalNameAr: 'النخيل للخدمات الفنية ذ.م.م',
  tradeNameEn: 'Nakheel Technical Services L.L.C',
  tradeNameAr: 'النخيل للخدمات الفنية ذ.م.م',
  legalForm: 'Limited Liability Company',
  managerName: 'Rashid Omar Al Suwaidi',
  issuingAuthority: 'Abu Dhabi Department of Economic Development',
  emirate: 'Abu Dhabi',
  issueDate: '2026-03-05',
  expiryDate: '2027-03-04',
  establishmentDate: '2017-09-22',
  activities: awkwardActivities,
  registeredAddress: 'Unit 3, Mussafah Industrial Area M-14, Abu Dhabi',
};

export const STUB_FIXTURES: Record<string, StubFixture> = {
  /** Reads cleanly. One attempt, no issues. */
  clean: { firstPass: clean },

  /**
   * Also reads cleanly — the extraction is perfect. The licence simply expired
   * in 2024. No retry, because no amount of re-reading changes that.
   */
  expired: { firstPass: expired },

  /**
   * A harder layout — activities as prose, seal over the text, Abu Dhabi CN
   * number format. A current model reads it correctly, and so does the stub.
   */
  awkward: { firstPass: awkwardBase },

  /**
   * The same licence photographed: skewed, glare, noise, heavy JPEG. Also read
   * correctly, which is the point of the sample — it is what sending bytes to a
   * vision model buys over a text-extraction step that would return nothing.
   */
  scan: { firstPass: awkwardBase },
};

/** Returned for any document the stub has no fixture for. */
export const STUB_UNKNOWN_DOCUMENT: TradeLicence = {
  ...clean,
  licenceNumber: '000000',
  legalNameEn: 'Unrecognised Document (stub provider)',
  legalNameAr: null,
  activities: ['Stub provider: no fixture for this document'],
};
