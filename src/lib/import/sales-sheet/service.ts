/**
 * BP-06 Sales Sheet import — the stored workflow (migration 0081): preview and record, confirm,
 * cancel, read, failed rows. The background commit is ./commit.ts, run by the crm_import job.
 *
 * Trust boundaries:
 *  - every function takes an Authorization that only requirePermission() can issue for
 *    crm.import; the routes also require the create permission of every table the file writes
 *    (AC-S1) — the CRM's own policies re-check each write when the job runs;
 *  - the organization and the importer are the session's (auth.ctx), never the file's or the
 *    body's; crm_imports.created_by is stamped by the database (AC-S2);
 *  - matching sees only what the importer can see through RLS: a record they cannot see is not
 *    matched, and a key collision with it fails that row at commit — never another tenant's;
 *  - errors and logs carry row numbers and reasons, never row values (proposal §5).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import { requestWorkerWake } from '@/lib/jobs/wake';
import { REPRESENTATIVE_MAPPING, type MappingSpec } from './mapping';
import {
  buildPreview,
  failedRowsCsv,
  normaliseKey,
  type OrgSnapshot,
  type Preview,
  type TableCounts,
} from './preview';
import type { RowError } from './rows';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An import of a file counts as made once it is confirmed (AC-I1), not only once it finishes. */
const IMPORTED_STATUSES = sql`('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS')`;

export type ImportServiceCode =
  | 'NOT_FOUND'
  | 'NOT_IMPORTER'
  | 'PREVIEW_MISMATCH'
  | 'ALREADY_IMPORTED'
  | 'NOT_PREVIEWED'
  | 'INVALID_INCLUDE';

const notImporter = () =>
  new ImportServiceError('NOT_IMPORTER', 'Only the person who uploaded this import can do that.');

export class ImportServiceError extends Error {
  constructor(
    readonly code: ImportServiceCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(message);
    this.name = 'ImportServiceError';
  }
}

export interface PreviewCounts {
  companies: TableCounts;
  contacts: TableCounts;
  deals: TableCounts;
  validRows: number;
  invalidRows: number;
}

/** What crm_imports.preview_counts holds: counts and file-level notes, never row values. */
interface StoredPreview {
  counts: PreviewCounts;
  unknownHeaders: string[];
  conflicts: RowError[];
  /** Possible duplicates that would fail if included (preview.ts); confirm refuses them. */
  notIncludableRows: number[];
}

export interface ImportView {
  id: string;
  status: string;
  fileName: string;
  fileSha256: string;
  mappingId: string;
  dataRows: number;
  preview: StoredPreview;
  result: { created: number; linked: number; skipped: number; failed: number };
  invalidRows: { rowNumber: number; errors: RowError[] }[];
  possibleDuplicateRows: number[];
  includedRows: number[];
  /** An import of the same file in this organization that is queued, running or done (AC-I1). */
  earlierImportId: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ── Snapshot: the importing organization's keys, through RLS ─────────────────────

const companyKeyOf = (domain: string | null, name: string) =>
  domain ? `domain:${normaliseKey(domain)}` : `name:${normaliseKey(name)}`;

async function loadSnapshot(tx: Tx, orgId: string): Promise<OrgSnapshot> {
  const [companies, contacts, deals, owners, done] = await Promise.all([
    tx.execute<{ domain: string | null; name: string }>(sql`
      select c.domain, c.name from public.companies c
      where c.org_id = ${orgId}::uuid and c.deleted_at is null
    `),
    tx.execute<{
      email: string | null;
      first_name: string;
      last_name: string;
      co_domain: string | null;
      co_name: string | null;
    }>(sql`
      select ct.email, ct.first_name, ct.last_name, co.domain as co_domain, co.name as co_name
      from public.contacts ct
      left join public.companies co on co.id = ct.company_id and co.deleted_at is null
      where ct.org_id = ${orgId}::uuid and ct.deleted_at is null
    `),
    tx.execute<{
      title: string;
      co_domain: string | null;
      co_name: string | null;
      ct_email: string | null;
      ct_first: string | null;
      ct_last: string | null;
    }>(sql`
      select d.title, co.domain as co_domain, co.name as co_name,
             ct.email as ct_email, ct.first_name as ct_first, ct.last_name as ct_last
      from public.deals d
      left join public.companies co on co.id = d.company_id and co.deleted_at is null
      left join public.contacts ct on ct.id = d.contact_id and ct.deleted_at is null
      where d.org_id = ${orgId}::uuid and d.deleted_at is null
    `),
    tx.execute<{ id: string; email: string }>(sql`
      select p.id, lower(p.work_email::text) as email from public.people p
      where p.org_id = ${orgId}::uuid and p.deleted_at is null
        and p.person_status = 'ACTIVE' and p.work_email is not null
    `),
    tx.execute<{ file_sha256: string }>(sql`
      select i.file_sha256 from public.crm_imports i
      where i.org_id = ${orgId}::uuid and i.status in ${IMPORTED_STATUSES}
    `),
  ]);

  const contactKey = (
    email: string | null,
    first: string | null,
    last: string | null,
    companyKey: string,
  ) =>
    email
      ? `email:${normaliseKey(email)}`
      : `name:${normaliseKey(`${first ?? ''} ${last ?? ''}`)}|${companyKey}`;

  return {
    companyDomains: new Set(
      companies.rows.filter((c) => c.domain).map((c) => normaliseKey(c.domain!)),
    ),
    companyNames: new Set(companies.rows.map((c) => normaliseKey(c.name))),
    contactEmails: new Map(
      contacts.rows
        .filter((c) => c.email)
        .map((c) => [
          normaliseKey(c.email!),
          c.co_name !== null ? companyKeyOf(c.co_domain, c.co_name) : null,
        ]),
    ),
    contactNameCompany: new Set(
      contacts.rows
        .filter((c) => c.co_name !== null)
        .map(
          (c) =>
            `${normaliseKey(`${c.first_name} ${c.last_name}`)}|${companyKeyOf(c.co_domain, c.co_name!)}`,
        ),
    ),
    dealKeys: new Set(
      deals.rows
        .filter((d) => d.co_name !== null)
        .map((d) => {
          const ck = companyKeyOf(d.co_domain, d.co_name!);
          const kk =
            d.ct_email !== null || d.ct_first !== null
              ? contactKey(d.ct_email, d.ct_first, d.ct_last, ck)
              : '';
          return `${normaliseKey(d.title)}|${ck}|${kk}`;
        }),
    ),
    activeOwnersByEmail: new Map(owners.rows.map((o) => [normaliseKey(o.email), o.id])),
    completedFileHashes: new Set(done.rows.map((r) => r.file_sha256)),
  };
}

// ── Preview and record ────────────────────────────────────────────────────────────

const FileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((s) => !/[\p{Cc}]/u.test(s), 'must not contain control characters');

const INSERT_CHUNK = 1000;

/**
 * Parses and previews the file, then records the import and every row (AC-P1, AC-A3). Writes
 * nothing to CRM tables (AC-P3). Refusals of the whole file (ImportRefusal) record nothing.
 */
export async function createImportPreview(
  auth: Authorization,
  input: { fileName: unknown; bytes: Uint8Array },
  spec: MappingSpec = REPRESENTATIVE_MAPPING,
): Promise<ImportView> {
  const fileName = FileNameSchema.parse(input.fileName);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    const snapshot = await loadSnapshot(tx, auth.ctx.orgId);
    const preview: Preview = buildPreview(input.bytes, spec, snapshot);
    const stored: StoredPreview = {
      counts: {
        ...preview.counts,
        validRows: preview.validRows.length,
        invalidRows: preview.invalidRows.length,
      },
      unknownHeaders: preview.unknownHeaders,
      conflicts: preview.conflicts,
      notIncludableRows: preview.notIncludableRows,
    };
    const created = await tx.execute<{ id: string }>(sql`
      insert into public.crm_imports (
        org_id, created_by, file_name, file_sha256, mapping_id, header, data_rows, preview_counts
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid, ${fileName}, ${preview.fileSha256},
        ${spec.id}, ${JSON.stringify(preview.header)}::jsonb, ${preview.dataRows},
        ${JSON.stringify(stored)}::jsonb
      )
      returning id
    `);
    const importId = created.rows[0]?.id;
    if (!importId) throw new Error('Import record creation failed.');

    const records = [
      ...preview.validRows.map((r) => ({
        row_number: r.rowNumber,
        source_values: r.values,
        status: 'PENDING',
        errors: [] as RowError[],
        planned_company: r.company,
        planned_contact: r.contact,
        planned_deal: r.deal,
        company_key: r.companyKey,
        contact_key: r.contactKey,
      })),
      ...preview.invalidRows.map((r) => ({
        row_number: r.rowNumber,
        source_values: r.values,
        status: 'FAILED',
        errors: r.errors,
        planned_company: null,
        planned_contact: null,
        planned_deal: null,
        company_key: null,
        contact_key: null,
      })),
    ].sort((a, b) => a.row_number - b.row_number);

    for (let at = 0; at < records.length; at += INSERT_CHUNK) {
      const chunk = records.slice(at, at + INSERT_CHUNK);
      await tx.execute(sql`
        insert into public.crm_import_rows (
          org_id, import_id, row_number, source_values, status, errors,
          planned_company, planned_contact, planned_deal, company_key, contact_key
        )
        select ${auth.ctx.orgId}::uuid, ${importId}::uuid, r.row_number, r.source_values,
               r.status, r.errors, r.planned_company, r.planned_contact, r.planned_deal,
               r.company_key, r.contact_key
        from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as r(
          row_number integer, source_values jsonb, status text, errors jsonb,
          planned_company text, planned_contact text, planned_deal text,
          company_key text, contact_key text)
      `);
    }
    return importId;
  });
  return getImport(auth, id);
}

// ── Read ──────────────────────────────────────────────────────────────────────────

export async function getImport(auth: Authorization, id: string): Promise<ImportView> {
  if (!UUID.test(id)) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const head = await tx.execute<{
      id: string;
      status: string;
      file_name: string;
      file_sha256: string;
      mapping_id: string;
      data_rows: number;
      preview_counts: StoredPreview;
      created_count: number;
      linked_count: number;
      skipped_count: number;
      failed_count: number;
      created_at: string;
      completed_at: string | null;
    }>(sql`
      select i.id, i.status, i.file_name, i.file_sha256, i.mapping_id, i.data_rows,
             i.preview_counts, i.created_count, i.linked_count, i.skipped_count,
             i.failed_count, i.created_at, i.completed_at
      from public.crm_imports i
      where i.id = ${id}::uuid and i.org_id = ${auth.ctx.orgId}::uuid
    `);
    const row = head.rows[0];
    if (!row) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
    const [invalid, duplicates, earlier] = await Promise.all([
      tx.execute<{ row_number: number; errors: RowError[] }>(sql`
        select r.row_number, r.errors from public.crm_import_rows r
        where r.import_id = ${id}::uuid and r.status = 'FAILED'
        order by r.row_number
      `),
      tx.execute<{ row_number: number; include: boolean }>(sql`
        select r.row_number, r.include from public.crm_import_rows r
        where r.import_id = ${id}::uuid
          and 'POSSIBLE_DUPLICATE' in (coalesce(r.planned_company, ''),
                                       coalesce(r.planned_contact, ''),
                                       coalesce(r.planned_deal, ''))
        order by r.row_number
      `),
      earlierImport(tx, auth.ctx.orgId, row.file_sha256, id),
    ]);
    return {
      id: row.id,
      status: row.status,
      fileName: row.file_name,
      fileSha256: row.file_sha256,
      mappingId: row.mapping_id,
      dataRows: row.data_rows,
      preview: row.preview_counts,
      result: {
        created: row.created_count,
        linked: row.linked_count,
        skipped: row.skipped_count,
        failed: row.failed_count,
      },
      invalidRows: invalid.rows.map((r) => ({
        rowNumber: r.row_number,
        errors: r.errors.map((e) => ({ ...e, rowNumber: r.row_number })),
      })),
      possibleDuplicateRows: duplicates.rows.map((r) => r.row_number),
      includedRows: duplicates.rows.filter((r) => r.include).map((r) => r.row_number),
      earlierImportId: earlier,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  });
}

async function earlierImport(
  tx: Tx,
  orgId: string,
  sha: string,
  exceptId: string,
): Promise<string | null> {
  const res = await tx.execute<{ id: string }>(sql`
    select i.id from public.crm_imports i
    where i.org_id = ${orgId}::uuid and i.file_sha256 = ${sha} and i.id <> ${exceptId}::uuid
      and i.status in ${IMPORTED_STATUSES}
    order by i.created_at desc
    limit 1
  `);
  return res.rows[0]?.id ?? null;
}

// ── Confirm (AC-P3, AC-I1, AC-I3, AC-A1) ──────────────────────────────────────────

const TableCountsSchema = z.strictObject({
  create: z.number().int().min(0),
  link: z.number().int().min(0),
  possibleDuplicate: z.number().int().min(0),
});
export const ConfirmImportSchema = z.strictObject({
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.strictObject({
    companies: TableCountsSchema,
    contacts: TableCountsSchema,
    deals: TableCountsSchema,
    validRows: z.number().int().min(0),
    invalidRows: z.number().int().min(0),
  }),
  includeRows: z.array(z.number().int().min(2).max(10_001)).max(10_000).default([]),
  allowReimport: z.boolean().default(false),
});

const sameCounts = (a: PreviewCounts, b: PreviewCounts) =>
  a.validRows === b.validRows &&
  a.invalidRows === b.invalidRows &&
  (['companies', 'contacts', 'deals'] as const).every(
    (t) =>
      a[t].create === b[t].create &&
      a[t].link === b[t].link &&
      a[t].possibleDuplicate === b[t].possibleDuplicate,
  );

/**
 * Confirms the preview the user saw — bound to the file's SHA-256 and the preview counts — and
 * queues the background commit. Idempotent: confirming an import that is already queued, running
 * or finished for the same file returns it unchanged and starts no second job.
 */
export async function confirmImport(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<ImportView> {
  if (!UUID.test(id)) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
  const body = ConfirmImportSchema.parse(input);
  const queued = await withAuthorizedDb(auth.ctx, async (tx) => {
    const head = await tx.execute<{
      status: string;
      file_sha256: string;
      file_name: string;
      data_rows: number;
      preview_counts: StoredPreview;
      job_id: string | null;
      created_by: string;
    }>(sql`
      select i.status, i.file_sha256, i.file_name, i.data_rows, i.preview_counts, i.job_id,
             i.created_by
      from public.crm_imports i
      where i.id = ${id}::uuid and i.org_id = ${auth.ctx.orgId}::uuid
      for update
    `);
    const row = head.rows[0];
    if (!row) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
    // Only the importer confirms (the 0081 guard refuses anyone else too).
    if (row.created_by !== auth.ctx.personId) throw notImporter();
    if (
      row.file_sha256 !== body.fileSha256 ||
      !sameCounts(row.preview_counts.counts, body.counts)
    ) {
      throw new ImportServiceError(
        'PREVIEW_MISMATCH',
        'The confirmation does not match this import’s file and preview.',
      );
    }
    if (row.status !== 'PREVIEWED') {
      if (row.job_id !== null) return false; // AC-I3: the same import, no second job
      throw new ImportServiceError('NOT_PREVIEWED', `The import is ${row.status}.`);
    }

    // AC-I1 across concurrent confirmations: imports of the same file in this organization are
    // confirmed one at a time, so a second one sees the first as queued (it counts as imported).
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`crm_import:${auth.ctx.orgId}:${row.file_sha256}`}, 0))
    `);
    const earlier = await earlierImport(tx, auth.ctx.orgId, row.file_sha256, id);
    if (earlier && !body.allowReimport) {
      throw new ImportServiceError(
        'ALREADY_IMPORTED',
        'This file was already imported, or is being imported, by this organization.',
        { earlierImportId: earlier },
      );
    }

    const include = [...new Set(body.includeRows)];
    const notIncludable = new Set(row.preview_counts.notIncludableRows);
    if (include.some((n) => notIncludable.has(n))) {
      throw new ImportServiceError(
        'INVALID_INCLUDE',
        'A row that would fail if included cannot be included (its contact belongs to the existing company).',
      );
    }
    if (include.length > 0) {
      const eligible = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from public.crm_import_rows r
        where r.import_id = ${id}::uuid and r.status = 'PENDING'
          and r.row_number in (select (jsonb_array_elements_text(${JSON.stringify(include)}::jsonb))::int)
          and 'POSSIBLE_DUPLICATE' in (coalesce(r.planned_company, ''),
                                       coalesce(r.planned_contact, ''),
                                       coalesce(r.planned_deal, ''))
      `);
      if (eligible.rows[0]?.n !== include.length) {
        throw new ImportServiceError(
          'INVALID_INCLUDE',
          'Only rows reported as possible duplicates can be included.',
        );
      }
      await tx.execute(sql`
        update public.crm_import_rows r set include = true
        where r.import_id = ${id}::uuid
          and r.row_number in (select (jsonb_array_elements_text(${JSON.stringify(include)}::jsonb))::int)
      `);
    }

    // The job goes through the jobs_insert policy (jobs.create) like any enqueue. Its id is
    // chosen here, with no RETURNING and no ON CONFLICT: under RLS both also need the jobs
    // SELECT policy (jobs.view), which importing must not require. A concurrent second
    // confirmation cannot reach this point — the import row is locked above and it then sees
    // QUEUED — so the unique dedup key is a backstop: a duplicate raises, never a second job.
    const jobId = randomUUID();
    const inserted = await tx.execute(sql`
      insert into public.jobs (id, org_id, type, priority, payload, max_attempts, dedup_key)
      values (${jobId}::uuid, ${auth.ctx.orgId}::uuid, 'crm_import', 0,
              ${JSON.stringify({ importId: id })}::jsonb, 5, ${`crm_import:${id}`})
    `);
    if ((inserted.rowCount ?? 0) !== 1) throw new Error('INTERNAL: crm_import job not created');

    await tx.execute(sql`
      update public.crm_imports
      set status = 'QUEUED', job_id = ${jobId}::uuid, allow_reimport = ${body.allowReimport}
      where id = ${id}::uuid
    `);
    // AC-A1: in the same transaction as the status change; ids, name, hash and counts only.
    await tx.execute(sql`
      select public.write_audit_log(
        p_action      := 'crm.import.started',
        p_entity_type := 'crm_import',
        p_result      := 'SUCCESS'::public.audit_result,
        p_entity_id   := ${id}::uuid,
        p_severity    := 'MEDIUM',
        p_metadata    := ${JSON.stringify({
          importId: id,
          jobId,
          fileName: row.file_name,
          fileSha256: row.file_sha256,
          dataRows: row.data_rows,
          validRows: row.preview_counts.counts.validRows,
          invalidRows: row.preview_counts.counts.invalidRows,
          includedRows: include.length,
          reimport: earlier !== null,
        })}::jsonb,
        p_request_id  := ${auth.meta.requestId}::uuid,
        p_actor_ip    := ${auth.meta.ip}::inet,
        p_user_agent  := ${auth.meta.userAgent}
      )
    `);
    return true;
  });
  if (queued) await requestWorkerWake();
  return getImport(auth, id);
}

// ── Cancel ────────────────────────────────────────────────────────────────────────

/** PREVIEWED or QUEUED → CANCELLED. A queued job then ends without writing anything. */
export async function cancelImport(auth: Authorization, id: string): Promise<ImportView> {
  if (!UUID.test(id)) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const head = await tx.execute<{ status: string; created_by: string }>(sql`
      select i.status, i.created_by from public.crm_imports i
      where i.id = ${id}::uuid and i.org_id = ${auth.ctx.orgId}::uuid
      for update
    `);
    const status = head.rows[0]?.status;
    if (!status) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
    if (head.rows[0]!.created_by !== auth.ctx.personId) throw notImporter();
    if (status === 'CANCELLED') return;
    if (status !== 'PREVIEWED' && status !== 'QUEUED') {
      throw new ImportServiceError('NOT_PREVIEWED', `The import is ${status}.`);
    }
    await tx.execute(sql`
      update public.crm_imports set status = 'CANCELLED' where id = ${id}::uuid
    `);
  });
  return getImport(auth, id);
}

// ── Failed rows (AC-C4) ───────────────────────────────────────────────────────────

export async function failedRowsFor(auth: Authorization, id: string): Promise<string> {
  if (!UUID.test(id)) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const head = await tx.execute<{ header: string[] }>(sql`
      select i.header from public.crm_imports i
      where i.id = ${id}::uuid and i.org_id = ${auth.ctx.orgId}::uuid
    `);
    const header = head.rows[0]?.header;
    if (!header) throw new ImportServiceError('NOT_FOUND', 'Import not found.');
    const rows = await tx.execute<{
      row_number: number;
      source_values: string[];
      errors: { column: string | null; reason: string }[];
    }>(sql`
      select r.row_number, r.source_values, r.errors from public.crm_import_rows r
      where r.import_id = ${id}::uuid and r.status = 'FAILED'
      order by r.row_number
    `);
    return failedRowsCsv(
      header,
      rows.rows.map((r) => ({
        rowNumber: r.row_number,
        values: r.source_values,
        errors: r.errors.map((e) => ({ ...e, rowNumber: r.row_number })),
      })),
    );
  });
}
