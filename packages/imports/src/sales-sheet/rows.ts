/**
 * BP-06 Sales Sheet import — turning one sheet row into CRM inputs (proposal AC-P2, AC-F4).
 *
 * Field rules are the CRM's own: each candidate is checked with the create schema the CRM's
 * create endpoints use (CreateCompanySchema, CreateContactSchema, CreateDealSchema), so an
 * imported record can never be one the CRM itself would refuse. The import adds only what a
 * spreadsheet needs on top: fixed formats for dates, amounts and percentages (never guessed),
 * and the owner column, resolved later against the importing organization's people.
 */
import type { z } from 'zod';
import {
  CreateCompanySchema,
  CreateContactSchema,
  CreateDealSchema,
  type CreateCompanyInput,
  type CreateContactInput,
  type CreateDealInput,
} from '@/lib/crm/schema';
import type { MappingSpec, TargetField } from './mapping';

export interface RowError {
  rowNumber: number;
  /** The sheet column the error belongs to, or null for a whole-row error. */
  column: string | null;
  reason: string;
}

export interface RowCandidate {
  rowNumber: number;
  company: CreateCompanyInput | null;
  /** Without companyId: the link is made when the row is committed. */
  contact: Omit<CreateContactInput, 'companyId'> | null;
  deal: Omit<CreateDealInput, 'companyId' | 'contactId'> | null;
  ownerEmail: string | null;
  errors: RowError[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AMOUNT = /^\d+(\.\d{1,4})?$/;

/** A real calendar date in YYYY-MM-DD; 2026-02-30 and 03/04/2026 are refused, never guessed. */
export function strictIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function zodErrors(
  rowNumber: number,
  error: z.ZodError,
  columnOf: (path: PropertyKey | undefined) => string | null,
): RowError[] {
  return error.issues.map((issue) => ({
    rowNumber,
    column: columnOf(issue.path[0]),
    reason: issue.message,
  }));
}

export function buildCandidate(
  rowNumber: number,
  values: string[],
  index: Partial<Record<TargetField, number>>,
  spec: MappingSpec,
  headerCount: number,
): RowCandidate {
  const errors: RowError[] = [];
  const header = (f: TargetField) => spec.columns[f]?.header ?? f;
  const get = (f: TargetField): string | null => {
    const at = index[f];
    if (at === undefined) return null;
    const v = (values[at] ?? '').trim();
    return v === '' ? null : v;
  };
  if (values.length !== headerCount) {
    errors.push({
      rowNumber,
      column: null,
      reason: `has ${values.length} values; the header has ${headerCount}`,
    });
  }

  // ── Company (required by the representative mapping: every row names one) ─────
  const companyFieldColumn: Record<string, TargetField> = {
    name: 'companyName',
    domain: 'companyDomain',
    industry: 'companyIndustry',
    addressCity: 'companyCity',
    countryCode: 'companyCountryCode',
  };
  let company: CreateCompanyInput | null = null;
  const companyRaw = {
    name: get('companyName') ?? '',
    domain: get('companyDomain')?.toLowerCase() ?? null,
    industry: get('companyIndustry'),
    addressCity: get('companyCity'),
    ...(get('companyCountryCode') ? { countryCode: get('companyCountryCode') } : {}),
  };
  const c = CreateCompanySchema.safeParse(companyRaw);
  if (c.success && c.data.domain && /[\s\p{Cc}]/u.test(c.data.domain)) {
    errors.push({
      rowNumber,
      column: header('companyDomain'),
      reason: 'is not a valid domain (it contains a space or a control character)',
    });
  }
  if (c.success) company = c.data;
  else
    errors.push(
      ...zodErrors(rowNumber, c.error, (p) =>
        header(companyFieldColumn[String(p)] ?? 'companyName'),
      ),
    );

  // ── Contact (optional: present when any contact column has a value) ────────────
  let contact: RowCandidate['contact'] = null;
  const contactFieldColumn: Record<string, TargetField> = {
    firstName: 'contactFirstName',
    lastName: 'contactLastName',
    email: 'contactEmail',
    phone: 'contactPhone',
  };
  if (Object.values(contactFieldColumn).some((f) => get(f) !== null)) {
    const p = CreateContactSchema.omit({ companyId: true }).safeParse({
      firstName: get('contactFirstName') ?? '',
      lastName: get('contactLastName') ?? '',
      email: get('contactEmail')?.toLowerCase() ?? null,
      phone: get('contactPhone'),
    });
    if (p.success) contact = p.data;
    else
      errors.push(
        ...zodErrors(rowNumber, p.error, (k) =>
          header(contactFieldColumn[String(k)] ?? 'contactFirstName'),
        ),
      );
  }

  // ── Deal (optional: present when the row has a deal title or any deal value) ───
  let deal: RowCandidate['deal'] = null;
  const dealCols: TargetField[] = [
    'dealTitle',
    'dealValue',
    'dealCurrency',
    'dealStage',
    'dealProbability',
    'dealExpectedCloseDate',
  ];
  if (dealCols.some((f) => get(f) !== null)) {
    let value: string | null = get('dealValue');
    if (value !== null && spec.amountThousandsSeparator) {
      value = value.split(spec.amountThousandsSeparator).join('');
    }
    if (value !== null && !AMOUNT.test(value)) {
      errors.push({
        rowNumber,
        column: header('dealValue'),
        reason: 'must be a non-negative amount with at most 4 decimals',
      });
      value = null;
    }
    let probability: number | null = null;
    const rawProbability = get('dealProbability');
    if (rawProbability !== null) {
      const m = /^(\d{1,3})%?$/.exec(rawProbability);
      if (!m || Number(m[1]) > 100) {
        errors.push({
          rowNumber,
          column: header('dealProbability'),
          reason: 'must be a whole number from 0 to 100',
        });
      } else probability = Number(m[1]);
    }
    const close = get('dealExpectedCloseDate');
    if (close !== null && !strictIsoDate(close)) {
      errors.push({
        rowNumber,
        column: header('dealExpectedCloseDate'),
        reason: 'must be a real date written YYYY-MM-DD',
      });
    }
    const dealFieldColumn: Record<string, TargetField> = {
      title: 'dealTitle',
      value: 'dealValue',
      currency: 'dealCurrency',
      stage: 'dealStage',
      probability: 'dealProbability',
      expectedCloseDate: 'dealExpectedCloseDate',
    };
    const d = CreateDealSchema.omit({ companyId: true, contactId: true }).safeParse({
      title: get('dealTitle') ?? '',
      value,
      ...(get('dealCurrency') ? { currency: get('dealCurrency') } : {}),
      ...(get('dealStage') ? { stage: get('dealStage')!.toUpperCase() } : {}),
      probability,
      expectedCloseDate: close !== null && strictIsoDate(close) ? close : null,
    });
    if (d.success) deal = d.data;
    else
      errors.push(
        ...zodErrors(rowNumber, d.error, (k) => header(dealFieldColumn[String(k)] ?? 'dealTitle')),
      );
  }

  const ownerEmail = get('ownerEmail')?.toLowerCase() ?? null;
  if (ownerEmail === null) {
    errors.push({ rowNumber, column: header('ownerEmail'), reason: 'is required' });
  }

  return { rowNumber, company, contact, deal, ownerEmail, errors };
}
