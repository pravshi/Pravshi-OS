/**
 * BP-06 Sales Sheet import — the column mapping (proposal AC-F3, AC-F4).
 *
 * THE REAL MAPPING IS NOT KNOWN. The Sales Sheet's columns are recorded nowhere in this
 * repository (proposal §7). REPRESENTATIVE_MAPPING below is a documented stand-in, used with
 * tests/fixtures/sales-sheet/representative.csv to build and test everything that does not
 * depend on the real columns. It must be replaced by the founder-approved mapping before the
 * import is used; validation against the actual sheet is PENDING.
 */

/** Every CRM field an import row can fill. Names follow the CRM create schemas. */
export type TargetField =
  | 'companyName'
  | 'companyDomain'
  | 'companyIndustry'
  | 'companyCity'
  | 'companyCountryCode'
  | 'contactFirstName'
  | 'contactLastName'
  | 'contactEmail'
  | 'contactPhone'
  | 'dealTitle'
  | 'dealValue'
  | 'dealCurrency'
  | 'dealStage'
  | 'dealProbability'
  | 'dealExpectedCloseDate'
  | 'ownerEmail';

export interface ColumnRule {
  /** The sheet's header text, matched after trimming and case-folding. */
  header: string;
  /** A missing required column refuses the whole file before preview. */
  required: boolean;
}

export interface MappingSpec {
  /** Identifies the mapping in the import record, so a preview names what it was built with. */
  id: string;
  columns: Partial<Record<TargetField, ColumnRule>>;
  /** The one accepted date format (AC-F4): an ambiguous date is never guessed. */
  dateFormat: 'YYYY-MM-DD';
  /** Probability column: whole numbers 0–100, an optional trailing '%'. */
  probabilityFormat: 'integer-percent';
  /** Amounts: digits with an optional '.', up to 4 decimals; thousands separators removed. */
  amountThousandsSeparator: ',' | null;
}

/** A documented stand-in — NOT the real Sales Sheet mapping (see the file comment). */
export const REPRESENTATIVE_MAPPING: MappingSpec = {
  id: 'representative-2026-10-24',
  columns: {
    companyName: { header: 'Company', required: true },
    companyDomain: { header: 'Company Domain', required: false },
    companyIndustry: { header: 'Industry', required: false },
    companyCity: { header: 'City', required: false },
    companyCountryCode: { header: 'Country', required: false },
    contactFirstName: { header: 'Contact First Name', required: false },
    contactLastName: { header: 'Contact Last Name', required: false },
    contactEmail: { header: 'Contact Email', required: false },
    contactPhone: { header: 'Contact Phone', required: false },
    dealTitle: { header: 'Deal Title', required: false },
    dealValue: { header: 'Deal Value', required: false },
    dealCurrency: { header: 'Currency', required: false },
    dealStage: { header: 'Stage', required: false },
    dealProbability: { header: 'Probability', required: false },
    dealExpectedCloseDate: { header: 'Expected Close', required: false },
    ownerEmail: { header: 'Owner Email', required: true },
  },
  dateFormat: 'YYYY-MM-DD',
  probabilityFormat: 'integer-percent',
  amountThousandsSeparator: ',',
};

const fold = (s: string) => s.trim().toLocaleLowerCase('en');

export interface HeaderResolution {
  /** Column index for each mapped field present in the file. */
  index: Partial<Record<TargetField, number>>;
  missingRequired: string[];
  unknownHeaders: string[];
  duplicateHeaders: string[];
}

/** Matches the file's header row to the mapping (trimmed, case-folded, exact otherwise). */
export function resolveHeader(header: string[], spec: MappingSpec): HeaderResolution {
  const positions = new Map<string, number>();
  const duplicateHeaders: string[] = [];
  header.forEach((h, i) => {
    const key = fold(h);
    if (positions.has(key)) duplicateHeaders.push(h.trim());
    else positions.set(key, i);
  });
  const index: Partial<Record<TargetField, number>> = {};
  const missingRequired: string[] = [];
  const known = new Set<string>();
  for (const [field, rule] of Object.entries(spec.columns) as [TargetField, ColumnRule][]) {
    known.add(fold(rule.header));
    const at = positions.get(fold(rule.header));
    if (at === undefined) {
      if (rule.required) missingRequired.push(rule.header);
    } else {
      index[field] = at;
    }
  }
  const unknownHeaders = header
    .filter((h) => !known.has(fold(h)) && h.trim() !== '')
    .map((h) => h.trim());
  return { index, missingRequired, unknownHeaders, duplicateHeaders };
}
