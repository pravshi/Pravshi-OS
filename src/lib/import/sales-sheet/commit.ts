/**
 * BP-06 Sales Sheet import — the background commit (proposal AC-C1–AC-C3, AC-I2, AC-A1, AC-A2).
 *
 * Runs as the importer: the crm_import job resolves its principal through
 * crm_import_execute_as_job() (./job.ts), and every statement here goes through
 * withAuthorizedDb() under that identity, so the CRM's own policies and triggers decide each
 * write exactly as for the CRM's create endpoints:
 *  - a record is inserted with the importer as owner (the insert policies require it) and then
 *    handed to the row's owner by an ordinary UPDATE, which the owner-reach trigger (0033)
 *    allows only within the importer's companies/contacts/deals.edit scope;
 *  - a record an earlier row created is linked to only while the importer can still see it;
 *  - created_by/updated_by are stamped and every insert and update is audited whole-row by the
 *    CRM tables' own triggers; the import row records the ids (AC-A2).
 * Not dispatched: the deal.created workflow event — an open product decision (implementation
 * record, E9).
 *
 * Batches of rows, each in one transaction; each row in its own savepoint (AC-C2). A row that
 * fails is rolled back alone and recorded FAILED with a reason — never its values. An error that
 * is not about the row (a lost connection) fails the batch: its rows stay PENDING, and the job's
 * retry resumes from them (AC-I2). A row is decided at most once (the 0081 guard). The duplicate
 * rules are the preview's (./preview.ts).
 */
import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import { MAPPINGS, resolveHeader, type MappingSpec, type TargetField } from './mapping';
import { buildCandidate } from './rows';

const BATCH = 100;
const CLOSED_STAGES = new Set(['WON', 'LOST']);

/** A reason the row cannot be applied. Its message is shown to the user: never a value. */
class RowRefusal extends Error {}

type PendingRow = {
  row_number: number;
  source_values: string[];
  planned_company: string | null;
  planned_contact: string | null;
  planned_deal: string | null;
  company_key: string | null;
  contact_key: string | null;
  include: boolean;
};

type Outcome =
  | {
      status: 'CREATED' | 'LINKED';
      companyId: string;
      contactId: string | null;
      dealId: string | null;
    }
  | { status: 'SKIPPED' }
  | { status: 'FAILED'; reason: string };

/** How a commit run ended, for the job handler. */
export type CommitResult =
  /** The import reached a final status (this run or an earlier one), or is cancelled. */
  | 'DONE'
  /** The importer can no longer see the import (lost crm.import): only the worker can fail it. */
  | 'NOT_VISIBLE';

/** The first SQLSTATE in an error or its causes (drizzle wraps the driver's error). */
export function pgError(error: unknown): { code?: string; constraint?: string } {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: unknown; constraint?: unknown };
    if (typeof x.code === 'string') {
      return {
        code: x.code,
        constraint: typeof x.constraint === 'string' ? x.constraint : undefined,
      };
    }
  }
  return {};
}

/**
 * A database refusal of this row, as a reason shown to the user; null when the error is not
 * about the row (the batch then fails and is retried). Reasons name constraints, never values.
 */
export function rowReason(error: unknown): string | null {
  if (error instanceof RowRefusal) return error.message;
  const { code, constraint } = pgError(error);
  if (!code) return null;
  if (code === '23505') return 'a record with the same key already exists';
  if (code === '42501') {
    return 'not permitted: the owner is outside your reach, or a permission is missing';
  }
  if (code.startsWith('23') || code.startsWith('22')) {
    return `refused by the database (${constraint ?? code})`;
  }
  return null;
}

const hasPossibleDuplicate = (r: PendingRow) =>
  [r.planned_company, r.planned_contact, r.planned_deal].includes('POSSIBLE_DUPLICATE');

async function handOver(
  tx: Tx,
  table: 'companies' | 'contacts' | 'deals',
  id: string,
  owner: string,
  me: string,
): Promise<void> {
  if (owner === me) return;
  const res = await tx.execute(sql`
    update ${sql.raw(`public.${table}`)} set owner_person_id = ${owner}::uuid, updated_at = now()
    where id = ${id}::uuid
  `);
  if ((res.rowCount ?? 0) !== 1) {
    throw new RowRefusal(`not permitted: you cannot edit the new ${table} record to set its owner`);
  }
}

/** The record an earlier row of this import created or linked for the same key, if any. */
async function earlierRecord(
  tx: Tx,
  importId: string,
  column: 'company_id' | 'contact_id',
  keyColumn: 'company_key' | 'contact_key',
  key: string | null,
): Promise<string | undefined> {
  if (key === null) return undefined;
  const res = await tx.execute<{ id: string }>(sql`
    select ${sql.raw(`r.${column}`)} as id from public.crm_import_rows r
    where r.import_id = ${importId}::uuid and ${sql.raw(`r.${keyColumn}`)} = ${key}
      and ${sql.raw(`r.${column}`)} is not null
    limit 1
  `);
  return res.rows[0]?.id;
}

async function applyRow(
  tx: Tx,
  ctx: AuthContext,
  importId: string,
  row: PendingRow,
  header: string[],
  index: Partial<Record<TargetField, number>>,
  spec: MappingSpec,
): Promise<Outcome> {
  if (hasPossibleDuplicate(row) && !row.include) return { status: 'SKIPPED' };
  const cand = buildCandidate(row.row_number, row.source_values, index, spec, header.length);
  if (cand.errors.length > 0 || !cand.company || cand.ownerEmail === null) {
    // The preview accepted it with the same code and mapping; this would be a defect.
    throw new RowRefusal('the row no longer validates');
  }

  const owner = await tx.execute<{ id: string }>(sql`
    select p.id from public.people p
    where p.org_id = ${ctx.orgId}::uuid and lower(p.work_email::text) = ${cand.ownerEmail}
      and p.deleted_at is null and p.person_status = 'ACTIVE'
  `);
  const ownerId = owner.rows[0]?.id;
  if (!ownerId) {
    throw new RowRefusal('the owner is no longer an active person of this organization');
  }

  let created = false;

  // ── Company: an earlier row of this file, then the domain, then a new one ──────
  const company = cand.company;
  let companyId = await earlierRecord(tx, importId, 'company_id', 'company_key', row.company_key);
  if (companyId) {
    const visible = await tx.execute(sql`
      select 1 from public.companies c where c.id = ${companyId}::uuid and c.deleted_at is null
    `);
    if (visible.rows.length === 0) {
      throw new RowRefusal('the company an earlier row created is no longer visible to you');
    }
  } else if (company.domain) {
    companyId = (
      await tx.execute<{ id: string }>(sql`
        select c.id from public.companies c
        where c.org_id = ${ctx.orgId}::uuid and lower(c.domain) = lower(${company.domain})
          and c.deleted_at is null
      `)
    ).rows[0]?.id;
  }
  if (!companyId) {
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.companies (
        org_id, owner_person_id, name, domain, industry, size, website, phone,
        address_line1, address_line2, city, state, postal_code, country_code
      ) values (
        ${ctx.orgId}::uuid, ${ctx.personId}::uuid,
        ${company.name}, ${company.domain ?? null}, ${company.industry ?? null},
        ${company.size ?? null}, ${company.website ?? null}, ${company.phone ?? null},
        ${company.addressLine1 ?? null}, ${company.addressLine2 ?? null},
        ${company.addressCity ?? null}, ${company.addressState ?? null},
        ${company.addressPostalCode ?? null}, ${company.countryCode}
      )
      returning id
    `);
    companyId = res.rows[0]?.id;
    if (!companyId) throw new Error('INTERNAL: company insert returned no row');
    await handOver(tx, 'companies', companyId, ownerId, ctx.personId);
    created = true;
  }

  // ── Contact: an earlier row, then the email, then a new one ────────────────────
  let contactId: string | null = null;
  if (cand.contact) {
    const earlier = await earlierRecord(tx, importId, 'contact_id', 'contact_key', row.contact_key);
    let found: { id: string; company_id: string | null } | undefined;
    if (earlier) {
      found = (
        await tx.execute<{ id: string; company_id: string | null }>(sql`
          select c.id, c.company_id from public.contacts c
          where c.id = ${earlier}::uuid and c.deleted_at is null
        `)
      ).rows[0];
      if (!found) {
        throw new RowRefusal('the contact an earlier row created is no longer visible to you');
      }
    } else if (cand.contact.email) {
      found = (
        await tx.execute<{ id: string; company_id: string | null }>(sql`
          select c.id, c.company_id from public.contacts c
          where c.org_id = ${ctx.orgId}::uuid and lower(c.email) = lower(${cand.contact.email})
            and c.deleted_at is null
        `)
      ).rows[0];
    }
    if (found) {
      if (found.company_id !== companyId) {
        throw new RowRefusal('the contact already exists under another company');
      }
      contactId = found.id;
    } else {
      const res = await tx.execute<{ id: string }>(sql`
        insert into public.contacts (
          org_id, owner_person_id, company_id, first_name, last_name, email, phone, title,
          department
        ) values (
          ${ctx.orgId}::uuid, ${ctx.personId}::uuid, ${companyId}::uuid,
          ${cand.contact.firstName}, ${cand.contact.lastName},
          ${cand.contact.email ?? null}, ${cand.contact.phone ?? null},
          ${cand.contact.title ?? null}, ${cand.contact.department ?? null}
        )
        returning id
      `);
      contactId = res.rows[0]?.id ?? null;
      if (!contactId) throw new Error('INTERNAL: contact insert returned no row');
      await handOver(tx, 'contacts', contactId, ownerId, ctx.personId);
      created = true;
    }
  }

  // ── Deal: always new (no natural key, AC-D3) ────────────────────────────────────
  let dealId: string | null = null;
  if (cand.deal) {
    const deal = cand.deal;
    const target = (
      await tx.execute<{ pipeline_id: string; stage_id: string }>(sql`
        select r.pipeline_id, r.stage_id from public.crm_default_pipeline_stage(${deal.stage}) r
      `)
    ).rows[0];
    if (!target) throw new RowRefusal('this organization has no default pipeline');
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.deals (
        org_id, owner_person_id, title, company_id, contact_id, value, currency, stage,
        pipeline_id, pipeline_stage_id, probability, expected_close_date, closed_at
      ) values (
        ${ctx.orgId}::uuid, ${ctx.personId}::uuid, ${deal.title},
        ${companyId}::uuid, ${contactId}::uuid, ${deal.value ?? null}::numeric,
        ${deal.currency}, ${deal.stage}, ${target.pipeline_id}::uuid, ${target.stage_id}::uuid,
        ${deal.probability ?? null}, ${deal.expectedCloseDate ?? null}::date,
        ${CLOSED_STAGES.has(deal.stage) ? sql`now()` : sql`null`}
      )
      returning id
    `);
    dealId = res.rows[0]?.id ?? null;
    if (!dealId) throw new Error('INTERNAL: deal insert returned no row');
    await handOver(tx, 'deals', dealId, ownerId, ctx.personId);
    created = true;
  }

  return { status: created ? 'CREATED' : 'LINKED', companyId, contactId, dealId };
}

async function recordOutcome(
  tx: Tx,
  importId: string,
  rowNumber: number,
  outcome: Outcome,
): Promise<void> {
  let set;
  if (outcome.status === 'SKIPPED') {
    set = sql`status = 'SKIPPED'`;
  } else if (outcome.status === 'FAILED') {
    set = sql`status = 'FAILED',
              errors = ${JSON.stringify([{ column: null, reason: outcome.reason }])}::jsonb`;
  } else {
    set = sql`status = ${outcome.status}, company_id = ${outcome.companyId}::uuid,
              contact_id = ${outcome.contactId}::uuid, deal_id = ${outcome.dealId}::uuid`;
  }
  const res = await tx.execute(sql`
    update public.crm_import_rows set ${set}
    where import_id = ${importId}::uuid and row_number = ${rowNumber} and status = 'PENDING'
  `);
  // Not a row problem: something else decided it, or it is not visible. Fail the batch.
  if ((res.rowCount ?? 0) !== 1) throw new Error('INTERNAL: import row outcome not recorded');
}

/** The import as its importer sees it now, or null when it is not visible to them. */
async function headOf(tx: Tx, ctx: AuthContext, importId: string, lock = false) {
  const res = await tx.execute<{
    status: string;
    mapping_id: string;
    header: string[];
    job_id: string | null;
    file_name: string;
    file_sha256: string;
  }>(sql`
    select i.status, i.mapping_id, i.header, i.job_id, i.file_name, i.file_sha256
    from public.crm_imports i
    where i.id = ${importId}::uuid and i.org_id = ${ctx.orgId}::uuid
    ${lock ? sql`for update` : sql``}
  `);
  return res.rows[0] ?? null;
}

const auditImport = (
  tx: Tx,
  importId: string,
  action: 'crm.import.completed' | 'crm.import.failed',
  result: 'SUCCESS' | 'ERROR',
  metadata: Record<string, string | number | null>,
  requestId: string,
) =>
  tx.execute(sql`
    select public.write_audit_log(
      p_action      := ${action},
      p_entity_type := 'crm_import',
      p_result      := ${result}::public.audit_result,
      p_entity_id   := ${importId}::uuid,
      p_severity    := 'MEDIUM',
      p_metadata    := ${JSON.stringify(metadata)}::jsonb,
      p_request_id  := ${requestId}::uuid,
      p_actor_ip    := null::inet,
      p_user_agent  := null
    )
  `);

/**
 * Commits a QUEUED or RUNNING import as `ctx` (the importer). Resumable: only PENDING rows are
 * read, so a second run after an interruption continues where the first stopped.
 */
export async function runImportCommit(
  ctx: AuthContext,
  importId: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<CommitResult> {
  const head = await withAuthorizedDb(ctx, async (tx) => {
    const row = await headOf(tx, ctx, importId, true);
    if (row?.status === 'QUEUED') {
      await tx.execute(sql`
        update public.crm_imports set status = 'RUNNING' where id = ${importId}::uuid
      `);
    }
    return row;
  });
  if (!head) return 'NOT_VISIBLE';
  if (head.status !== 'QUEUED' && head.status !== 'RUNNING') return 'DONE';

  const spec = MAPPINGS[head.mapping_id];
  if (!spec) {
    await withAuthorizedDb(ctx, async (tx) => {
      await tx.execute(sql`
        update public.crm_imports set status = 'FAILED', failure_reason = 'UNKNOWN_MAPPING'
        where id = ${importId}::uuid and status in ('QUEUED', 'RUNNING')
      `);
      await auditImport(
        tx,
        importId,
        'crm.import.failed',
        'ERROR',
        {
          importId,
          jobId: head.job_id,
          reason: 'UNKNOWN_MAPPING',
          fileName: head.file_name,
          fileSha256: head.file_sha256,
        },
        requestId,
      );
    });
    return 'DONE';
  }
  const { index } = resolveHeader(head.header, spec);

  // Until no PENDING row is left: a batch smaller than BATCH does not prove the end.
  for (;;) {
    if (signal?.aborted) throw new Error('crm_import commit interrupted; it resumes on retry');
    const processed = await withAuthorizedDb(ctx, async (tx) => {
      const rows = await tx.execute<PendingRow>(sql`
        select r.row_number, r.source_values, r.planned_company, r.planned_contact,
               r.planned_deal, r.company_key, r.contact_key, r.include
        from public.crm_import_rows r
        where r.import_id = ${importId}::uuid and r.status = 'PENDING'
        order by r.row_number
        limit ${BATCH}
        for update
      `);
      for (const row of rows.rows) {
        let outcome: Outcome;
        try {
          outcome = await tx.transaction((sp) =>
            applyRow(sp, ctx, importId, row, head.header, index, spec),
          );
        } catch (error) {
          const reason = rowReason(error);
          if (reason === null) throw error; // not about the row: fail the batch, retry later
          outcome = { status: 'FAILED', reason };
        }
        await recordOutcome(tx, importId, row.row_number, outcome);
      }
      return rows.rows.length;
    });
    if (processed === 0) break;
  }

  return withAuthorizedDb(ctx, async (tx): Promise<CommitResult> => {
    const failed = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from public.crm_import_rows r
      where r.import_id = ${importId}::uuid and r.status = 'FAILED'
    `);
    const status = (failed.rows[0]?.n ?? 0) > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    const done = await tx.execute<{
      created_count: number;
      linked_count: number;
      skipped_count: number;
      failed_count: number;
    }>(sql`
      update public.crm_imports set status = ${status}
      where id = ${importId}::uuid and status = 'RUNNING'
      returning created_count, linked_count, skipped_count, failed_count
    `);
    const row = done.rows[0];
    if (!row) {
      // Finished by a concurrent run — or the import is no longer visible to the importer.
      return (await headOf(tx, ctx, importId)) ? 'DONE' : 'NOT_VISIBLE';
    }
    // AC-A1: in the same transaction as the completion.
    await auditImport(
      tx,
      importId,
      'crm.import.completed',
      'SUCCESS',
      {
        importId,
        jobId: head.job_id,
        status,
        fileName: head.file_name,
        fileSha256: head.file_sha256,
        created: row.created_count,
        linked: row.linked_count,
        skipped: row.skipped_count,
        failed: row.failed_count,
      },
      requestId,
    );
    return 'DONE';
  });
}
