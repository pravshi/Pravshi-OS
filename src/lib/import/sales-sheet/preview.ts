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
 *
 * The rules, applied identically by the commit (./commit.ts):
 *  - a row with any possible duplicate is skipped unless included, and until then creates
 *    nothing a later row can link to;
 *  - company: an earlier committing row of the file → LINK; the same domain in the organization
 *    → LINK; the same name without a domain → POSSIBLE_DUPLICATE (every such row); else CREATE;
 *  - contact: likewise by email, by name + company as a possible duplicate; an email already
 *    under another company (in the file or the organization) is a row error;
 *  - deal: the same title + company + contact as a live deal or a committing row of the file →
 *    POSSIBLE_DUPLICATE; else CREATE.
 *  - a possible-duplicate company row whose contact links to an existing contact cannot be
 *    included (it would create a new company and then fail): notIncludableRows.
 * The counts describe a commit with nothing included: a row with a possible duplicate counts
 * only its possible duplicates. Including rows can change later rows' outcomes (a later row may
 * then link to, or conflict with, what the included row creates); the commit's counts are final.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS, ImportFileError, decodeUtf8, parseCsv, type ImportLimits } from './csv';
import { resolveHeader, type MappingSpec } from './mapping';
import { buildCandidate, type RowCandidate, type RowError } from './rows';

/** The importing organization's existing keys, all already normalised by normaliseKey(). */
export interface OrgSnapshot {
  companyDomains: ReadonlySet<string>;
  companyNames: ReadonlySet<string>;
  /** Normalised contact email → the company key of that contact's company (null: none). */
  contactEmails: ReadonlyMap<string, string | null>;
  /** `${normalisedFullName}|${normalisedCompanyKey}` */
  contactNameCompany: ReadonlySet<string>;
  /**
   * How many live companies carry each normalised name. "Use the existing company" for a
   * name-only match is refused when more than one does: the user must add a domain (or create a
   * new one) — the import never guesses which (duplicate resolution). Absent: every match counts 1.
   */
  companyNameCounts?: ReadonlyMap<string, number>;
  /** `${normalisedTitle}|${normalisedCompanyKey}|${normalisedContactKey}` */
  dealKeys: ReadonlySet<string>;
  /** Normalised email → person id, ACTIVE people of the importing organization only. */
  activeOwnersByEmail: ReadonlyMap<string, string>;
  /** SHA-256 of files this organization has imported or is importing (queued, running, done). */
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
  /** Within-file identity (AC-D4): rows with the same key are one record. */
  companyKey: string;
  contactKey: string | null;
  /** The row's values as the file had them (stored with the import, AC-A3). */
  values: string[];
}

export interface TableCounts {
  create: number;
  link: number;
  possibleDuplicate: number;
}

/**
 * A user's decision about one possible duplicate (duplicate resolution). Companies and contacts
 * are decided once per entity — every row that names it follows — and deals once per deal key.
 *
 *   LINK_EXISTING  use the existing record (companies and contacts only)
 *   CREATE_NEW     create a new record although a similar one exists
 *   SKIP           import nothing from the rows that need it
 */
export type DuplicateDecision = 'LINK_EXISTING' | 'CREATE_NEW' | 'SKIP';

export interface ImportDecisions {
  companies: ReadonlyMap<string, DuplicateDecision>;
  contacts: ReadonlyMap<string, DuplicateDecision>;
  deals: ReadonlyMap<string, Exclude<DuplicateDecision, 'LINK_EXISTING'>>;
}

export const NO_DECISIONS: ImportDecisions = {
  companies: new Map(),
  contacts: new Map(),
  deals: new Map(),
};

export interface Unresolved {
  companies: string[];
  contacts: string[];
  deals: string[];
}

export interface Preview {
  mappingId: string;
  fileSha256: string;
  /** The file's header row as written, for the failed-rows export. */
  header: string[];
  /** The file was already imported by this organization (AC-I1): commit needs explicit consent. */
  alreadyImported: boolean;
  dataRows: number;
  unknownHeaders: string[];
  validRows: PlannedRow[];
  invalidRows: { rowNumber: number; errors: RowError[]; values: string[] }[];
  counts: { companies: TableCounts; contacts: TableCounts; deals: TableCounts };
  /** Conflicting values for one company within the file (AC-D4). */
  conflicts: RowError[];
  /** Possible duplicates that would fail if included: they can only be skipped. */
  notIncludableRows: number[];
  /** Rows a SKIP decision excludes. */
  skippedRows: number[];
  /**
   * Possible duplicates still undecided, by entity key. While any remain, a commit would skip
   * their rows: nothing is ever created as a duplicate without an explicit decision.
   */
  unresolved: Unresolved;
}

export class ImportRefusal extends Error {
  constructor(
    readonly code:
      | 'MISSING_REQUIRED_COLUMNS'
      | 'DUPLICATE_HEADERS'
      | 'TOO_MANY_COLUMNS'
      | ImportFileError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ImportRefusal';
  }
}

const emptyCounts = (): TableCounts => ({ create: 0, link: 0, possibleDuplicate: 0 });

/** The widest row stored with an import (crm_imports / crm_import_rows checks, 0081). */
export const MAX_COLUMNS = 200;

export function buildPreview(
  bytes: Uint8Array,
  spec: MappingSpec,
  snapshot: OrgSnapshot,
  limits: ImportLimits = DEFAULT_LIMITS,
  decisions: ImportDecisions = NO_DECISIONS,
): Preview {
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');
  let parsed;
  try {
    parsed = parseCsv(decodeUtf8(bytes, limits), limits);
  } catch (e) {
    if (e instanceof ImportFileError) throw new ImportRefusal(e.code, e.message);
    throw e;
  }
  if (
    parsed.header.length > MAX_COLUMNS ||
    parsed.rows.some((r) => r.values.length > MAX_COLUMNS)
  ) {
    throw new ImportRefusal(
      'TOO_MANY_COLUMNS',
      `The file has a row with more than ${MAX_COLUMNS} columns.`,
    );
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

  return planPreview(
    { fileSha256, header: parsed.header, rows: parsed.rows },
    spec,
    snapshot,
    decisions,
  );
}

/**
 * The preview of already-parsed rows: what the upload computes from the file, and what the
 * decision API recomputes from the rows the import recorded (the raw file is never kept) after
 * each duplicate decision. Same rules, same result for the same rows.
 */
export function planPreview(
  input: {
    fileSha256: string;
    header: string[];
    rows: readonly { rowNumber: number; values: string[] }[];
  },
  spec: MappingSpec,
  snapshot: OrgSnapshot,
  decisions: ImportDecisions = NO_DECISIONS,
): Preview {
  const { fileSha256 } = input;
  const parsed = { header: input.header, rows: input.rows };
  const resolution = resolveHeader(parsed.header, spec);
  const counts = { companies: emptyCounts(), contacts: emptyCounts(), deals: emptyCounts() };
  const validRows: PlannedRow[] = [];
  const invalidRows: Preview['invalidRows'] = [];
  const conflicts: RowError[] = [];
  const notIncludableRows: number[] = [];
  const skippedRows: number[] = [];
  const unresolved = {
    companies: new Set<string>(),
    contacts: new Set<string>(),
    deals: new Set<string>(),
  };
  // Within-file identity (AC-D4): the first committing row creates, later rows with the same key
  // link. Contacts map to the company key they were first seen under.
  const fileCompanies = new Map<string, { rowNumber: number; industry: string | null }>();
  const fileContacts = new Map<string, string>();
  const fileDeals = new Set<string>();

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

    // Company: domain is the natural key; a name-only match is a possible duplicate — for every
    // row that names it, not only the first (AC-D1).
    const company = cand.company;
    const companyKey = company.domain
      ? `domain:${normaliseKey(company.domain)}`
      : `name:${normaliseKey(company.name)}`;
    let companyOutcome: Outcome;
    const seen = fileCompanies.get(companyKey);
    if (seen) {
      companyOutcome = 'LINK';
    } else if (company.domain && snapshot.companyDomains.has(normaliseKey(company.domain))) {
      companyOutcome = 'LINK';
    } else if (!company.domain && snapshot.companyNames.has(normaliseKey(company.name))) {
      companyOutcome = 'POSSIBLE_DUPLICATE';
    } else {
      companyOutcome = 'CREATE';
    }
    const companyDecision =
      companyOutcome === 'POSSIBLE_DUPLICATE' ? decisions.companies.get(companyKey) : undefined;
    let skip = companyDecision === 'SKIP';
    if (companyDecision === 'LINK_EXISTING') {
      if ((snapshot.companyNameCounts?.get(normaliseKey(company.name)) ?? 1) > 1) {
        errors.push({
          rowNumber,
          column: spec.columns.companyName?.header ?? 'companyName',
          reason:
            'matches more than one existing company; add the domain, create a new one, or skip',
        });
      }
      companyOutcome = 'LINK';
    } else if (companyDecision === 'CREATE_NEW') {
      companyOutcome = 'CREATE';
    }
    /** A company this file creates anew has no existing contacts or deals to collide with. */
    const newCompany = companyDecision === 'CREATE_NEW';

    // Contact: email is the natural key; name + company is a possible duplicate. An email that
    // already belongs to a contact under another company is a row error: the commit would refuse
    // it, so the preview says so (AC-D2).
    let contactOutcome: Outcome | null = null;
    let contactKey = '';
    let linksExistingContact = false;
    /** The user decided this possible-duplicate contact is a new person. */
    let contactDecidedNew = false;
    if (cand.contact) {
      const fullName = normaliseKey(`${cand.contact.firstName} ${cand.contact.lastName}`);
      const email = cand.contact.email ? normaliseKey(cand.contact.email) : null;
      contactKey = email ? `email:${email}` : `name:${fullName}|${companyKey}`;
      const inFile = fileContacts.get(contactKey);
      const existing = email ? snapshot.contactEmails.get(email) : undefined;
      if (inFile !== undefined || existing !== undefined) {
        if ((inFile ?? existing) !== companyKey) {
          errors.push({
            rowNumber,
            column: spec.columns.contactEmail?.header ?? 'contactEmail',
            reason: 'belongs to an existing contact under another company, or under none',
          });
        }
        contactOutcome = 'LINK';
        linksExistingContact = inFile === undefined;
      } else if (
        !email &&
        !newCompany &&
        snapshot.contactNameCompany.has(`${fullName}|${companyKey}`)
      ) {
        contactOutcome = 'POSSIBLE_DUPLICATE';
      } else {
        contactOutcome = 'CREATE';
      }
      if (contactOutcome === 'POSSIBLE_DUPLICATE') {
        const d = decisions.contacts.get(contactKey);
        if (d === 'SKIP') skip = true;
        else if (d === 'LINK_EXISTING') contactOutcome = 'LINK';
        else if (d === 'CREATE_NEW') {
          contactOutcome = 'CREATE';
          contactDecidedNew = true;
        }
      }
    }
    // A new company's contact cannot be an existing contact of the existing company.
    if (newCompany && linksExistingContact) {
      errors.push({
        rowNumber,
        column: spec.columns.contactEmail?.header ?? 'contactEmail',
        reason: 'belongs to a contact of the existing company; use the existing company, or skip',
      });
    }

    // Deal: no natural key; same title + company + contact as a live deal, or as an earlier
    // committing row of this file, is a possible duplicate (AC-D3).
    let dealOutcome: Outcome | null = null;
    let dealKey = '';
    if (cand.deal) {
      dealKey = `${normaliseKey(cand.deal.title)}|${companyKey}|${contactKey}`;
      // Only an explicit "create new" decision rules out the existing deals: a record the user
      // declared new has none.
      const againstExisting = !newCompany && !contactDecidedNew;
      dealOutcome =
        (againstExisting && snapshot.dealKeys.has(dealKey)) || fileDeals.has(dealKey)
          ? 'POSSIBLE_DUPLICATE'
          : 'CREATE';
      if (dealOutcome === 'POSSIBLE_DUPLICATE') {
        const d = decisions.deals.get(dealKey);
        if (d === 'SKIP') skip = true;
        else if (d === 'CREATE_NEW') dealOutcome = 'CREATE';
      }
    }

    if (errors.length > 0) {
      invalidRows.push({ rowNumber, errors, values });
      continue;
    }
    if (skip) {
      // A SKIP decision excludes the row: it creates nothing, links nothing, registers nothing.
      skippedRows.push(rowNumber);
      continue;
    }
    if (companyOutcome === 'POSSIBLE_DUPLICATE') unresolved.companies.add(companyKey);
    if (contactOutcome === 'POSSIBLE_DUPLICATE') unresolved.contacts.add(contactKey);
    if (dealOutcome === 'POSSIBLE_DUPLICATE') unresolved.deals.add(dealKey);

    // Within-file identity (AC-D4). A row with a possible duplicate is skipped unless the user
    // includes it, so until then it creates nothing a later row could link to: only rows without
    // one register their keys. (An included row is linked to at commit, which follows file
    // order; the final counts are the commit's.)
    const deferred = [companyOutcome, contactOutcome, dealOutcome].includes('POSSIBLE_DUPLICATE');
    if (!deferred) {
      if (seen && (seen.industry ?? null) !== (company.industry ?? null)) {
        conflicts.push({
          rowNumber,
          column: spec.columns.companyIndustry?.header ?? 'companyIndustry',
          reason: `differs from row ${seen.rowNumber} for the same company; row ${seen.rowNumber} wins`,
        });
      }
      if (!seen) fileCompanies.set(companyKey, { rowNumber, industry: company.industry ?? null });
      if (cand.contact && !fileContacts.has(contactKey)) fileContacts.set(contactKey, companyKey);
      if (cand.deal) fileDeals.add(dealKey);
    }

    // Including a possible-duplicate company creates a new one; a contact this row links to an
    // existing contact under the existing company would then fail. Such a row is skipped, never
    // included (confirm refuses it).
    if (companyOutcome === 'POSSIBLE_DUPLICATE' && linksExistingContact) {
      notIncludableRows.push(rowNumber);
    }

    // The counts say what a commit with nothing included does (E11): a deferred row adds only its
    // possible duplicates — the rest of it is skipped with it.
    const bump = (t: TableCounts, o: Outcome | null) => {
      if (o === 'POSSIBLE_DUPLICATE') t.possibleDuplicate += 1;
      else if (deferred) return;
      else if (o === 'CREATE') t.create += 1;
      else if (o === 'LINK') t.link += 1;
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
      companyKey,
      contactKey: cand.contact ? contactKey : null,
      values,
    });
  }

  return {
    mappingId: spec.id,
    fileSha256,
    header: parsed.header,
    alreadyImported: snapshot.completedFileHashes.has(fileSha256),
    dataRows: parsed.rows.length,
    unknownHeaders: resolution.unknownHeaders,
    validRows,
    invalidRows,
    counts,
    conflicts,
    notIncludableRows,
    skippedRows,
    unresolved: {
      companies: [...unresolved.companies],
      contacts: [...unresolved.contacts],
      deals: [...unresolved.deals],
    },
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
