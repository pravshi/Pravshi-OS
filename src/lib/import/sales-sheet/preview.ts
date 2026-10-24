/**
 * BP-06 Sales Sheet import — the preview (proposal AC-P1, AC-P3, AC-P4, AC-D1–AC-D5, AC-I1).
 *
 * Pure: given the file bytes, the mapping and a snapshot of the importing organization's
 * existing keys (taken through the normal authorised data path by the caller), it says what a
 * commit WOULD do, writing nothing. The organization never comes from the file: the snapshot is
 * the session organization's, and owners resolve only against its ACTIVE people.
 *
 * Existing records are never modified (AC-D5): a match is LINKED to, a probable match without a
 * natural key is reported as a POSSIBLE DUPLICATE and not created unless the user includes it.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS, ImportFileError, decodeUtf8, parseCsv, type ImportLimits } from './csv';
import { resolveHeader, type MappingSpec } from './mapping';
import { buildCandidate, type RowCandidate, type RowError } from './rows';

/** The importing organization's existing keys, all already normalised by normaliseKey(). */
export interface OrgSnapshot {
  companyDomains: ReadonlySet<string>;
  companyNames: ReadonlySet<string>;
  contactEmails: ReadonlySet<string>;
  /** `${normalisedFullName}|${normalisedCompanyKey}` */
  contactNameCompany: ReadonlySet<string>;
  /** `${normalisedTitle}|${normalisedCompanyKey}|${normalisedContactKey}` */
  dealKeys: ReadonlySet<string>;
  /** Normalised email → person id, ACTIVE people of the importing organization only. */
  activeOwnersByEmail: ReadonlyMap<string, string>;
  /** SHA-256 of files already imported (COMPLETED) by this organization. */
  completedFileHashes: ReadonlySet<string>;
}

/** Trimmed, case-folded, internal whitespace collapsed (AC-D1). */
export const normaliseKey = (s: string) => s.trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');

export type Outcome = 'CREATE' | 'LINK' | 'POSSIBLE_DUPLICATE';

export interface PlannedRow {
  rowNumber: number;
  company: Outcome | null;
  contact: Outcome | null;
  deal: Outcome | null;
  ownerPersonId: string | null;
}

export interface TableCounts {
  create: number;
  link: number;
  possibleDuplicate: number;
}

export interface Preview {
  mappingId: string;
  fileSha256: string;
  /** The file was already imported by this organization (AC-I1): commit needs explicit consent. */
  alreadyImported: boolean;
  dataRows: number;
  unknownHeaders: string[];
  validRows: PlannedRow[];
  invalidRows: { rowNumber: number; errors: RowError[]; values: string[] }[];
  counts: { companies: TableCounts; contacts: TableCounts; deals: TableCounts };
  /** Conflicting values for one company within the file (AC-D4). */
  conflicts: RowError[];
}

export class ImportRefusal extends Error {
  constructor(
    readonly code: 'MISSING_REQUIRED_COLUMNS' | 'DUPLICATE_HEADERS' | ImportFileError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ImportRefusal';
  }
}

const emptyCounts = (): TableCounts => ({ create: 0, link: 0, possibleDuplicate: 0 });

export function buildPreview(
  bytes: Uint8Array,
  spec: MappingSpec,
  snapshot: OrgSnapshot,
  limits: ImportLimits = DEFAULT_LIMITS,
): Preview {
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');
  let parsed;
  try {
    parsed = parseCsv(decodeUtf8(bytes, limits), limits);
  } catch (e) {
    if (e instanceof ImportFileError) throw new ImportRefusal(e.code, e.message);
    throw e;
  }
  const resolution = resolveHeader(parsed.header, spec);
  if (resolution.duplicateHeaders.length > 0) {
    throw new ImportRefusal(
      'DUPLICATE_HEADERS',
      `These columns appear more than once: ${resolution.duplicateHeaders.join(', ')}.`,
    );
  }
  if (resolution.missingRequired.length > 0) {
    throw new ImportRefusal(
      'MISSING_REQUIRED_COLUMNS',
      `These required columns are missing: ${resolution.missingRequired.join(', ')}.`,
    );
  }

  const counts = { companies: emptyCounts(), contacts: emptyCounts(), deals: emptyCounts() };
  const validRows: PlannedRow[] = [];
  const invalidRows: Preview['invalidRows'] = [];
  const conflicts: RowError[] = [];
  // Within-file identity (AC-D4): the first row creates, later rows with the same key link.
  const fileCompanies = new Map<string, { rowNumber: number; industry: string | null }>();
  const fileContacts = new Set<string>();

  for (const { rowNumber, values } of parsed.rows) {
    const cand: RowCandidate = buildCandidate(
      rowNumber,
      values,
      resolution.index,
      spec,
      parsed.header.length,
    );
    const errors = [...cand.errors];
    const ownerPersonId =
      cand.ownerEmail !== null ? (snapshot.activeOwnersByEmail.get(cand.ownerEmail) ?? null) : null;
    if (cand.ownerEmail !== null && ownerPersonId === null) {
      errors.push({
        rowNumber,
        column: spec.columns.ownerEmail?.header ?? 'ownerEmail',
        reason: 'is not an active person of this organization',
      });
    }
    if (errors.length > 0 || !cand.company) {
      invalidRows.push({ rowNumber, errors, values });
      continue;
    }

    // Company: domain is the natural key; a name-only match is a possible duplicate.
    const company = cand.company;
    const companyKey = company.domain
      ? `domain:${normaliseKey(company.domain)}`
      : `name:${normaliseKey(company.name)}`;
    let companyOutcome: Outcome;
    const seen = fileCompanies.get(companyKey);
    if (seen) {
      companyOutcome = 'LINK';
      if ((seen.industry ?? null) !== (company.industry ?? null)) {
        conflicts.push({
          rowNumber,
          column: spec.columns.companyIndustry?.header ?? 'companyIndustry',
          reason: `differs from row ${seen.rowNumber} for the same company; row ${seen.rowNumber} wins`,
        });
      }
    } else if (company.domain && snapshot.companyDomains.has(normaliseKey(company.domain))) {
      companyOutcome = 'LINK';
    } else if (!company.domain && snapshot.companyNames.has(normaliseKey(company.name))) {
      companyOutcome = 'POSSIBLE_DUPLICATE';
    } else {
      companyOutcome = 'CREATE';
    }
    if (!seen) fileCompanies.set(companyKey, { rowNumber, industry: company.industry ?? null });

    // Contact: email is the natural key; name + company is a possible duplicate.
    let contactOutcome: Outcome | null = null;
    let contactKey = '';
    if (cand.contact) {
      const fullName = normaliseKey(`${cand.contact.firstName} ${cand.contact.lastName}`);
      contactKey = cand.contact.email
        ? `email:${normaliseKey(cand.contact.email)}`
        : `name:${fullName}|${companyKey}`;
      if (fileContacts.has(contactKey)) contactOutcome = 'LINK';
      else if (cand.contact.email && snapshot.contactEmails.has(normaliseKey(cand.contact.email)))
        contactOutcome = 'LINK';
      else if (!cand.contact.email && snapshot.contactNameCompany.has(`${fullName}|${companyKey}`))
        contactOutcome = 'POSSIBLE_DUPLICATE';
      else contactOutcome = 'CREATE';
      fileContacts.add(contactKey);
    }

    // Deal: no natural key; same title + company + contact as a live deal is a possible duplicate.
    let dealOutcome: Outcome | null = null;
    if (cand.deal) {
      const dealKey = `${normaliseKey(cand.deal.title)}|${companyKey}|${contactKey}`;
      dealOutcome = snapshot.dealKeys.has(dealKey) ? 'POSSIBLE_DUPLICATE' : 'CREATE';
    }

    const bump = (t: TableCounts, o: Outcome | null) => {
      if (o === 'CREATE') t.create += 1;
      else if (o === 'LINK') t.link += 1;
      else if (o === 'POSSIBLE_DUPLICATE') t.possibleDuplicate += 1;
    };
    bump(counts.companies, companyOutcome);
    bump(counts.contacts, contactOutcome);
    bump(counts.deals, dealOutcome);
    validRows.push({
      rowNumber,
      company: companyOutcome,
      contact: contactOutcome,
      deal: dealOutcome,
      ownerPersonId,
    });
  }

  return {
    mappingId: spec.id,
    fileSha256,
    alreadyImported: snapshot.completedFileHashes.has(fileSha256),
    dataRows: parsed.rows.length,
    unknownHeaders: resolution.unknownHeaders,
    validRows,
    invalidRows,
    counts,
    conflicts,
  };
}

/**
 * Failed rows as CSV (AC-C4): the source row number, the original values and the reason.
 * Any value that a spreadsheet could execute — starting with =, +, -, @, tab or carriage
 * return — is prefixed with a single quote, and every field is RFC 4180 quoted.
 */
export function failedRowsCsv(header: string[], rows: Preview['invalidRows']): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [['Row', ...header, 'Errors'].map(cell).join(',')];
  for (const r of rows) {
    const reasons = r.errors
      .map((e) => (e.column ? `${e.column}: ${e.reason}` : e.reason))
      .join('; ');
    lines.push([String(r.rowNumber), ...r.values, reasons].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
