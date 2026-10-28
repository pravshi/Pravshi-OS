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
 *
 * Speed: the cost of a row is its round trips (~16 statements), not its work. So each batch is
 * first tried set-based (applyBatchFast: a handful of statements for the whole batch, through
 * the same policies and triggers), in a savepoint of its own. That attempt commits only when
 * every row of the batch would succeed or be skipped the way the per-row path decides it; at the
 * first row it cannot apply — or any refusal by the database — it is rolled back whole and the
 * batch is run row by row as above, which then decides each row exactly.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import { MAPPINGS, resolveHeader, type MappingSpec, type TargetField } from './mapping';
import { buildCandidate } from './rows';

const BATCH = 100;
const CLOSED_STAGES = new Set(['WON', 'LOST']);

/** A reason the row cannot be applied. Its message is shown to the user: never a value. */
class RowRefusal extends Error {}

/** The set-based attempt cannot decide this batch exactly: run it row by row instead. */
class FastPathDeclined extends Error {}

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

/** For tests: force the per-row path, or observe which path decided each batch. */
export type CommitOptions = {
  careful?: boolean;
  onBatch?: (path: 'FAST' | 'CAREFUL', rows: number) => void;
};

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

/**
 * The confirmed plan of a decided import (0088), per row; null when the import has none. The
 * existing company / contact a "use the existing" decision chose is recorded by id at
 * confirmation: the commit links to exactly that record, never re-matches a name.
 */
type RowPlan = {
  skip: boolean;
  companyExistingId: string | null;
  contactExistingId: string | null;
};
type RowPlans = ReadonlyMap<number, RowPlan> | null;

async function loadPlans(tx: Tx, importId: string): Promise<RowPlans> {
  const res = await tx.execute<{
    row_number: number;
    skip: boolean;
    company_existing_id: string | null;
    contact_existing_id: string | null;
  }>(sql`
    select p.row_number, p.skip, p.company_existing_id, p.contact_existing_id
    from public.crm_import_row_plans p where p.import_id = ${importId}::uuid
  `);
  if (res.rows.length === 0) return null;
  return new Map(
    res.rows.map((r) => [
      r.row_number,
      {
        skip: r.skip,
        companyExistingId: r.company_existing_id,
        contactExistingId: r.contact_existing_id,
      },
    ]),
  );
}

/** A plan that does anything beyond 0081's own rules (links by decision, or skips). */
const linksByDecision = (p: RowPlan) =>
  p.companyExistingId !== null || p.contactExistingId !== null;

/** "Use the existing company": the confirmed one, if it is still live and visible. */
async function confirmedCompany(tx: Tx, id: string): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`
    select c.id from public.companies c where c.id = ${id}::uuid and c.deleted_at is null
  `);
  if (res.rows.length === 0) {
    throw new RowRefusal('the existing company you chose is no longer visible to you');
  }
  return res.rows[0]!.id;
}

/** "Use the existing contact": the confirmed one, if it is still live and visible. */
async function confirmedContact(
  tx: Tx,
  id: string,
): Promise<{ id: string; company_id: string | null }> {
  const res = await tx.execute<{ id: string; company_id: string | null }>(sql`
    select c.id, c.company_id from public.contacts c
    where c.id = ${id}::uuid and c.deleted_at is null
  `);
  if (res.rows.length === 0) {
    throw new RowRefusal('the existing contact you chose is no longer visible to you');
  }
  return res.rows[0]!;
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
  plans: RowPlans = null,
): Promise<Outcome> {
  // A decided import follows its confirmed plan (0088); otherwise 0081's rule: a possible
  // duplicate is skipped unless the user included it.
  const plan = plans?.get(row.row_number);
  if (plans) {
    if (!plan || plan.skip) return { status: 'SKIPPED' };
  } else if (hasPossibleDuplicate(row) && !row.include) {
    return { status: 'SKIPPED' };
  }
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
  } else if (plan?.companyExistingId) {
    companyId = await confirmedCompany(tx, plan.companyExistingId);
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
    } else if (plan?.contactExistingId) {
      found = await confirmedContact(tx, plan.contactExistingId);
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

const asJson = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const distinct = (values: (string | null | undefined)[]) => [
  ...new Set(values.filter((v): v is string => typeof v === 'string' && v !== '')),
];
/** In-batch lookups compare with JS lower-casing, which matches lower() only for ASCII. */
const ASCII = /^[\x00-\x7f]*$/;

/** key → id; declines when a key has several (the per-row path would take whichever came first). */
function uniqueIds(rows: { k: string; id: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (map.has(r.k) && map.get(r.k) !== r.id) throw new FastPathDeclined();
    map.set(r.k, r.id);
  }
  return map;
}

/**
 * The batch, set-based: the same lookups, inserts and hand-overs as applyRow, one statement per
 * kind for the whole batch, then one outcome update. It applies the batch only when every row
 * would succeed or be skipped under applyRow with the same result; anything else — a row applyRow
 * would refuse, an ambiguous lookup, any refusal by the database — throws, and the caller rolls
 * the attempt back and decides the batch row by row. Writes are in applyRow's order for each
 * record (insert as the importer, then hand over), through the same policies and triggers.
 */
async function applyBatchFast(
  tx: Tx,
  ctx: AuthContext,
  importId: string,
  rows: PendingRow[],
  header: string[],
  index: Partial<Record<TargetField, number>>,
  spec: MappingSpec,
  plans: RowPlans = null,
): Promise<void> {
  // A decided import follows its confirmed plan: a planned skip is skipped here too, whatever
  // the row looked like at upload (the organization may have changed since). A row that links
  // by decision, or was a possible duplicate at upload, follows a decision this set-based path
  // does not apply: such a batch runs row by row. Every other row's plan is 0081's.
  if (
    plans &&
    rows.some((row) => {
      const p = plans.get(row.row_number);
      return p !== undefined && !p.skip && (linksByDecision(p) || hasPossibleDuplicate(row));
    })
  ) {
    throw new FastPathDeclined();
  }
  const work = rows.map((row) => {
    if (plans) {
      const p = plans.get(row.row_number);
      if (!p || p.skip) return { row, cand: null };
    } else if (hasPossibleDuplicate(row) && !row.include) {
      return { row, cand: null };
    }
    const cand = buildCandidate(row.row_number, row.source_values, index, spec, header.length);
    if (cand.errors.length > 0 || !cand.company || cand.ownerEmail === null) {
      throw new FastPathDeclined();
    }
    if (!ASCII.test(cand.company.domain ?? '') || !ASCII.test(cand.contact?.email ?? '')) {
      throw new FastPathDeclined();
    }
    return { row, cand };
  });
  const live = work.flatMap((w) => (w.cand ? [{ row: w.row, cand: w.cand }] : []));

  const lookup = async <T extends Record<string, unknown>>(
    values: string[],
    query: (list: ReturnType<typeof asJson>) => ReturnType<typeof sql>,
  ): Promise<T[]> =>
    values.length === 0 ? [] : ((await tx.execute<T>(query(asJson(values)))).rows as T[]);

  const owners = uniqueIds(
    await lookup<{ k: string; id: string }>(
      distinct(live.map((w) => w.cand.ownerEmail)),
      (list) => sql`
        select e.v as k, p.id from jsonb_array_elements_text(${list}) e(v)
        join public.people p on lower(p.work_email::text) = e.v
        where p.org_id = ${ctx.orgId}::uuid and p.deleted_at is null and p.person_status = 'ACTIVE'
      `,
    ),
  );
  const earlierCompany = uniqueIds(
    await lookup<{ k: string; id: string }>(
      distinct(live.map((w) => w.row.company_key)),
      (list) => sql`
        select r.company_key as k, r.company_id as id from public.crm_import_rows r
        where r.import_id = ${importId}::uuid and r.company_id is not null
          and r.company_key in (select jsonb_array_elements_text(${list}))
      `,
    ),
  );
  const earlierContact = uniqueIds(
    await lookup<{ k: string; id: string }>(
      distinct(live.map((w) => (w.cand.contact ? w.row.contact_key : null))),
      (list) => sql`
        select r.contact_key as k, r.contact_id as id from public.crm_import_rows r
        where r.import_id = ${importId}::uuid and r.contact_id is not null
          and r.contact_key in (select jsonb_array_elements_text(${list}))
      `,
    ),
  );
  const visibleCompanies = new Set(
    (
      await lookup<{ id: string }>(
        [...new Set(earlierCompany.values())],
        (list) => sql`
          select c.id from public.companies c
          where c.id in (select jsonb_array_elements_text(${list})::uuid) and c.deleted_at is null
        `,
      )
    ).map((r) => r.id),
  );
  const companyByDomain = uniqueIds(
    await lookup<{ k: string; id: string }>(
      distinct(live.map((w) => w.cand.company!.domain)),
      (list) => sql`
        select d.v as k, c.id from jsonb_array_elements_text(${list}) d(v)
        join public.companies c on lower(c.domain) = lower(d.v)
        where c.org_id = ${ctx.orgId}::uuid and c.deleted_at is null
      `,
    ),
  );
  /** Contact id → its company, for every contact a row may link to. */
  const contactCompany = new Map<string, string | null>();
  for (const r of await lookup<{ id: string; company_id: string | null }>(
    [...new Set(earlierContact.values())],
    (list) => sql`
      select c.id, c.company_id from public.contacts c
      where c.id in (select jsonb_array_elements_text(${list})::uuid) and c.deleted_at is null
    `,
  )) {
    contactCompany.set(r.id, r.company_id);
  }
  const byEmail = await lookup<{ k: string; id: string; company_id: string | null }>(
    distinct(live.map((w) => w.cand.contact?.email)),
    (list) => sql`
      select e.v as k, c.id, c.company_id from jsonb_array_elements_text(${list}) e(v)
      join public.contacts c on lower(c.email) = lower(e.v)
      where c.org_id = ${ctx.orgId}::uuid and c.deleted_at is null
    `,
  );
  const contactByEmail = uniqueIds(byEmail);
  for (const r of byEmail) contactCompany.set(r.id, r.company_id);
  const stages = new Map<string, { pipeline_id: string; stage_id: string }>();
  for (const r of await lookup<{ k: string; pipeline_id: string; stage_id: string }>(
    distinct(live.map((w) => w.cand.deal?.stage)),
    (list) => sql`
      select s.v as k, r.pipeline_id, r.stage_id from jsonb_array_elements_text(${list}) s(v)
      cross join lateral public.crm_default_pipeline_stage(s.v) r
    `,
  )) {
    if (stages.has(r.k)) throw new FastPathDeclined();
    stages.set(r.k, r);
  }

  // ── Decide every row in order, as applyRow would ────────────────────────────────
  const me = ctx.personId;
  const companies: Record<string, unknown>[] = [];
  const contacts: Record<string, unknown>[] = [];
  const deals: { closed: boolean; record: Record<string, unknown> }[] = [];
  const handOvers = { companies: [] as object[], contacts: [] as object[], deals: [] as object[] };
  const createdHere = new Set<string>();
  /** Records this batch creates that a later row links to: they must still be visible then. */
  const reused = { companies: new Set<string>(), contacts: new Set<string>() };
  const newCompanyByDomain = new Map<string, string>();
  const newContactByEmail = new Map<string, string>();
  const outcomes: Record<string, unknown>[] = [];

  for (const { row, cand } of work) {
    if (!cand) {
      outcomes.push({ row_number: row.row_number, status: 'SKIPPED' });
      continue;
    }
    const ownerId = owners.get(cand.ownerEmail!);
    if (!ownerId) throw new FastPathDeclined();
    let created = false;

    const company = cand.company!;
    let companyId = row.company_key === null ? undefined : earlierCompany.get(row.company_key);
    if (companyId) {
      if (!createdHere.has(companyId) && !visibleCompanies.has(companyId)) {
        throw new FastPathDeclined();
      }
    } else if (company.domain) {
      companyId =
        companyByDomain.get(company.domain) ?? newCompanyByDomain.get(company.domain.toLowerCase());
    }
    if (companyId) {
      if (createdHere.has(companyId)) reused.companies.add(companyId);
    } else {
      companyId = randomUUID();
      createdHere.add(companyId);
      companies.push({
        id: companyId,
        org_id: ctx.orgId,
        owner_person_id: me,
        name: company.name,
        domain: company.domain ?? null,
        industry: company.industry ?? null,
        size: company.size ?? null,
        website: company.website ?? null,
        phone: company.phone ?? null,
        address_line1: company.addressLine1 ?? null,
        address_line2: company.addressLine2 ?? null,
        city: company.addressCity ?? null,
        state: company.addressState ?? null,
        postal_code: company.addressPostalCode ?? null,
        country_code: company.countryCode,
      });
      if (ownerId !== me) handOvers.companies.push({ id: companyId, owner: ownerId });
      if (company.domain) newCompanyByDomain.set(company.domain.toLowerCase(), companyId);
      created = true;
    }
    if (row.company_key !== null && !earlierCompany.has(row.company_key)) {
      earlierCompany.set(row.company_key, companyId);
    }

    let contactId: string | null = null;
    if (cand.contact) {
      const email = cand.contact.email;
      const earlier = row.contact_key === null ? undefined : earlierContact.get(row.contact_key);
      let found: string | undefined;
      if (earlier) {
        if (!contactCompany.has(earlier)) throw new FastPathDeclined();
        found = earlier;
      } else if (email) {
        found = contactByEmail.get(email) ?? newContactByEmail.get(email.toLowerCase());
      }
      if (found) {
        if (contactCompany.get(found) !== companyId) throw new FastPathDeclined();
        if (createdHere.has(found)) reused.contacts.add(found);
        contactId = found;
      } else {
        contactId = randomUUID();
        createdHere.add(contactId);
        contactCompany.set(contactId, companyId);
        contacts.push({
          id: contactId,
          org_id: ctx.orgId,
          owner_person_id: me,
          company_id: companyId,
          first_name: cand.contact.firstName,
          last_name: cand.contact.lastName,
          email: email ?? null,
          phone: cand.contact.phone ?? null,
          title: cand.contact.title ?? null,
          department: cand.contact.department ?? null,
        });
        if (ownerId !== me) handOvers.contacts.push({ id: contactId, owner: ownerId });
        if (email) newContactByEmail.set(email.toLowerCase(), contactId);
        created = true;
      }
      if (row.contact_key !== null && !earlierContact.has(row.contact_key)) {
        earlierContact.set(row.contact_key, contactId);
      }
    }

    let dealId: string | null = null;
    if (cand.deal) {
      const deal = cand.deal;
      const target = stages.get(deal.stage);
      if (!target) throw new FastPathDeclined();
      dealId = randomUUID();
      deals.push({
        closed: CLOSED_STAGES.has(deal.stage),
        record: {
          id: dealId,
          org_id: ctx.orgId,
          owner_person_id: me,
          title: deal.title,
          company_id: companyId,
          contact_id: contactId,
          value: deal.value ?? null,
          currency: deal.currency,
          stage: deal.stage,
          pipeline_id: target.pipeline_id,
          pipeline_stage_id: target.stage_id,
          probability: deal.probability ?? null,
          expected_close_date: deal.expectedCloseDate ?? null,
        },
      });
      if (ownerId !== me) handOvers.deals.push({ id: dealId, owner: ownerId });
      created = true;
    }

    outcomes.push({
      row_number: row.row_number,
      status: created ? 'CREATED' : 'LINKED',
      company_id: companyId,
      contact_id: contactId,
      deal_id: dealId,
    });
  }

  // ── Write: each kind inserted as the importer, then handed over ─────────────────
  // RETURNING as in applyRow: it makes each new row pass the table's SELECT policy too, so an
  // importer who may create but not see a record is refused (42501) here exactly as there.
  const expectCount = (rowCount: number | null | undefined, n: number) => {
    if ((rowCount ?? 0) !== n) throw new FastPathDeclined();
  };
  const handOver = async (table: 'companies' | 'contacts' | 'deals') => {
    const list = handOvers[table];
    if (list.length === 0) return;
    const res = await tx.execute(sql`
      update ${sql.raw(`public.${table}`)} t set owner_person_id = x.owner, updated_at = now()
      from jsonb_to_recordset(${asJson(list)}) as x(id uuid, owner uuid)
      where t.id = x.id
    `);
    expectCount(res.rowCount, list.length);
  };
  if (companies.length > 0) {
    const res = await tx.execute(sql`
      insert into public.companies (
        id, org_id, owner_person_id, name, domain, industry, size, website, phone,
        address_line1, address_line2, city, state, postal_code, country_code
      )
      select x.id, x.org_id, x.owner_person_id, x.name, x.domain, x.industry, x.size, x.website,
             x.phone, x.address_line1, x.address_line2, x.city, x.state, x.postal_code,
             x.country_code
      from jsonb_populate_recordset(null::public.companies, ${asJson(companies)}) x
      returning id
    `);
    expectCount(res.rows.length, companies.length);
  }
  await handOver('companies');
  if (contacts.length > 0) {
    const res = await tx.execute(sql`
      insert into public.contacts (
        id, org_id, owner_person_id, company_id, first_name, last_name, email, phone, title,
        department
      )
      select x.id, x.org_id, x.owner_person_id, x.company_id, x.first_name, x.last_name, x.email,
             x.phone, x.title, x.department
      from jsonb_populate_recordset(null::public.contacts, ${asJson(contacts)}) x
      returning id
    `);
    expectCount(res.rows.length, contacts.length);
  }
  await handOver('contacts');
  if (deals.length > 0) {
    const res = await tx.execute(sql`
      insert into public.deals (
        id, org_id, owner_person_id, title, company_id, contact_id, value, currency, stage,
        pipeline_id, pipeline_stage_id, probability, expected_close_date, closed_at
      )
      select d.id, d.org_id, d.owner_person_id, d.title, d.company_id, d.contact_id, d.value,
             d.currency, d.stage, d.pipeline_id, d.pipeline_stage_id, d.probability,
             d.expected_close_date, case when x.closed then now() end
      from jsonb_to_recordset(${asJson(deals)}) as x(closed boolean, record jsonb)
      cross join lateral jsonb_populate_record(null::public.deals, x.record) d
      returning id
    `);
    expectCount(res.rows.length, deals.length);
  }
  await handOver('deals');

  // A record a later row links to must still be visible to the importer once handed over.
  for (const table of ['companies', 'contacts'] as const) {
    const ids = [...reused[table]];
    if (ids.length === 0) continue;
    const res = await tx.execute(sql`
      select t.id from ${sql.raw(`public.${table}`)} t
      where t.id in (select jsonb_array_elements_text(${asJson(ids)})::uuid)
        and t.deleted_at is null
    `);
    expectCount(res.rows.length, ids.length);
  }

  // SKIPPED leaves the ids as they are, as recordOutcome does.
  const res = await tx.execute(sql`
    update public.crm_import_rows r set
      status = x.status,
      company_id = case when x.status = 'SKIPPED' then r.company_id else x.company_id end,
      contact_id = case when x.status = 'SKIPPED' then r.contact_id else x.contact_id end,
      deal_id = case when x.status = 'SKIPPED' then r.deal_id else x.deal_id end
    from jsonb_populate_recordset(null::public.crm_import_rows, ${asJson(outcomes)}) x
    where r.import_id = ${importId}::uuid and r.row_number = x.row_number and r.status = 'PENDING'
  `);
  // Not a row problem: something else decided a row, or it is not visible. Fail the batch.
  if ((res.rowCount ?? 0) !== outcomes.length) {
    throw new Error('INTERNAL: import row outcome not recorded');
  }
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
  options: CommitOptions = {},
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
  // Written by the confirmation and immutable (0088): the same plan on every run and retry.
  const plans = await withAuthorizedDb(ctx, (tx) => loadPlans(tx, importId));

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
      if (rows.rows.length === 0) return 0;
      if (!options.careful) {
        try {
          await tx.transaction((sp) =>
            applyBatchFast(sp, ctx, importId, rows.rows, head.header, index, spec, plans),
          );
          options.onBatch?.('FAST', rows.rows.length);
          return rows.rows.length;
        } catch (error) {
          // Rolled back whole. A row-level refusal: decide the batch row by row below.
          if (!(error instanceof FastPathDeclined) && rowReason(error) === null) throw error;
        }
      }
      for (const row of rows.rows) {
        let outcome: Outcome;
        try {
          outcome = await tx.transaction((sp) =>
            applyRow(sp, ctx, importId, row, head.header, index, spec, plans),
          );
        } catch (error) {
          const reason = rowReason(error);
          if (reason === null) throw error; // not about the row: fail the batch, retry later
          outcome = { status: 'FAILED', reason };
        }
        await recordOutcome(tx, importId, row.row_number, outcome);
      }
      options.onBatch?.('CAREFUL', rows.rows.length);
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
