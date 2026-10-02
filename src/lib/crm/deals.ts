import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { softDeleteRow } from './soft-delete';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertDealReferences } from './refs';
import {
  CreateDealSchema,
  ListDealsQuerySchema,
  UpdateDealSchema,
  type Deal,
  type DealStage,
  type ListDealsQuery,
  type Page,
  type UpdateDealInput,
} from './schema';

/**
 * Deal service. Same trust boundaries as companies.ts, plus stage handling:
 *
 *  - The stage must be one of the six DealStage values (zod enum); anything else is
 *    rejected before it reaches the database, ahead of the CHECK constraint.
 *  - closed_at follows the stage: entering WON/LOST stamps it (first entry wins, via
 *    coalesce — reopening and re-closing keeps the original close); leaving for an
 *    open stage clears it. closed_at is never accepted from the caller.
 */

const CLOSED_STAGES: ReadonlySet<DealStage> = new Set(['WON', 'LOST']);

const SELECT_COLUMNS = sql`
  d.id,
  d.title,
  d.company_id as "companyId",
  co.name as "companyName",
  d.contact_id as "contactId",
  (ct.first_name || ' ' || ct.last_name) as "contactName",
  d.value::text as value,
  d.currency,
  d.stage,
  d.pipeline_id as "pipelineId",
  d.pipeline_stage_id as "pipelineStageId",
  d.probability,
  d.owner_person_id as "ownerPersonId",
  d.expected_close_date::text as "expectedCloseDate",
  d.closed_at::text as "closedAt",
  d.created_at as "createdAt",
  d.updated_at as "updatedAt"
`;

const FROM = sql`
  from public.deals d
  left join public.companies co
    on co.id = d.company_id
   and co.org_id = d.org_id
   and co.deleted_at is null
  left join public.contacts ct
    on ct.id = d.contact_id
   and ct.org_id = d.org_id
   and ct.deleted_at is null
`;

const BASE_WHERE = (auth: Authorization) => sql`
  d.org_id = ${auth.ctx.orgId}::uuid
  and d.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE on the title — the leading constant keeps the btree index usable.
  return sql` and d.title ilike ${search} || '%'`;
}

/** Optional stage filter for pipeline views. Validated against the enum. */
export async function listDeals(auth: Authorization, input: unknown): Promise<Page<Deal>> {
  const query: ListDealsQuery = ListDealsQuerySchema.parse(input);
  const stage = query.stage;
  const stageWhere = stage ? sql` and d.stage = ${stage}` : sql``;
  // U3: server-side related-record filters (replaces client-side filtering of a
  // capped list on detail pages).
  const companyWhere = query.companyId ? sql` and d.company_id = ${query.companyId}::uuid` : sql``;
  const contactWhere = query.contactId ? sql` and d.contact_id = ${query.contactId}::uuid` : sql``;
  const pipelineWhere = query.pipelineId
    ? sql` and d.pipeline_id = ${query.pipelineId}::uuid`
    : sql``;
  const relatedWhere = sql`${companyWhere} ${contactWhere} ${pipelineWhere}`;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Deal>(sql`
        select ${SELECT_COLUMNS}
        ${FROM}
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${stageWhere} ${relatedWhere}
        order by d.updated_at desc, d.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.deals d
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${stageWhere} ${relatedWhere}
      `),
    ]);
    return {
      rows: rows.rows,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

export async function getDeal(auth: Authorization, id: string): Promise<Deal> {
  const deal = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Deal>(sql`
      select ${SELECT_COLUMNS}
      ${FROM}
      where ${BASE_WHERE(auth)}
        and d.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, deal ? 1 : 0);
  return deal as Deal;
}

export async function createDeal(auth: Authorization, input: unknown): Promise<Deal> {
  const data = CreateDealSchema.parse(input);
  const closed = CLOSED_STAGES.has(data.stage);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    // A1: referenced company/contact must be visible in the caller's org, and a
    // contact must belong to the deal's company (composite FK in 0033).
    await assertDealReferences(tx, auth, data.companyId, data.contactId);
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.deals (
        org_id, owner_person_id,
        title, company_id, contact_id, value, currency, stage,
        probability, expected_close_date, closed_at
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.title},
        ${data.companyId ?? null}::uuid,
        ${data.contactId ?? null}::uuid,
        ${data.value ?? null}::numeric,
        ${data.currency},
        ${data.stage},
        ${data.probability ?? null},
        ${data.expectedCloseDate ?? null}::date,
        ${closed ? sql`now()` : sql`null`}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Deal creation failed.');
    return row.id;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'deal.created',
      entityType: 'deal',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { title: data.title, stage: data.stage },
    },
    auth.meta,
  );
  return getDeal(auth, id);
}

const UPDATE_COLUMNS: Record<Exclude<keyof UpdateDealInput, 'stage'>, string> = {
  title: 'title',
  companyId: 'company_id',
  contactId: 'contact_id',
  value: 'value',
  currency: 'currency',
  probability: 'probability',
  expectedCloseDate: 'expected_close_date',
};

export async function updateDeal(auth: Authorization, id: string, input: unknown): Promise<Deal> {
  const data = UpdateDealSchema.parse(input);
  const sets = Object.entries(data).map(([key, value]) => {
    if (key === 'stage') {
      const stage = value as DealStage;
      // Entering WON/LOST stamps closed_at (first entry wins); leaving clears it.
      // When the stage is untouched, closed_at is left alone.
      return sql`stage = ${stage}, closed_at = case
        when ${stage} in ('WON', 'LOST') then coalesce(closed_at, now())
        else null
      end`;
    }
    const column = UPDATE_COLUMNS[key as Exclude<keyof UpdateDealInput, 'stage'>];
    if (column === 'company_id' || column === 'contact_id')
      return sql`${sql.raw(column)} = ${value ?? null}::uuid`;
    if (column === 'value') return sql`${sql.raw(column)} = ${value ?? null}::numeric`;
    if (column === 'expected_close_date') return sql`${sql.raw(column)} = ${value ?? null}::date`;
    return sql`${sql.raw(column)} = ${value ?? null}`;
  });
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    // A1: probe the effective post-update references. Untouched references keep
    // their current values so the contact↔company pairing stays verifiable.
    let companyId: string | null | undefined = 'companyId' in data ? data.companyId : undefined;
    let contactId: string | null | undefined = 'contactId' in data ? data.contactId : undefined;
    if (companyId !== undefined || contactId !== undefined) {
      const cur = await tx.execute<{ company_id: string | null; contact_id: string | null }>(
        sql`
          select d.company_id, d.contact_id
          from public.deals d
          where d.id = ${id}::uuid
            and d.org_id = ${auth.ctx.orgId}::uuid
            and d.deleted_at is null
        `,
      );
      const row = cur.rows[0];
      if (companyId === undefined) companyId = row?.company_id ?? null;
      if (contactId === undefined) contactId = row?.contact_id ?? null;
      await assertDealReferences(tx, auth, companyId, contactId);
    }
    const res = await tx.execute(sql`
      update public.deals d
      set ${sql.join(sets, sql`, `)}, updated_at = now()
      where d.id = ${id}::uuid
        and ${BASE_WHERE(auth)}
      returning d.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'deal.updated',
      entityType: 'deal',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return getDeal(auth, id);
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function deleteDeal(auth: Authorization, id: string): Promise<void> {
  await softDeleteRow(
    auth,
    'deal',
    sql`public.deals d`,
    sql`d.id = ${id}::uuid and ${BASE_WHERE(auth)}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'deal.deleted',
      entityType: 'deal',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}
