import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { softDeleteRow } from './soft-delete';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertActivityReferences } from './refs';
import {
  CreateActivitySchema,
  ListActivitiesQuerySchema,
  UpdateActivitySchema,
  type Activity,
  type ListActivitiesQuery,
  type Page,
  type UpdateActivityInput,
} from './schema';

/**
 * Activity service. Same trust boundaries as companies.ts:
 *
 *  - org_id always comes from auth.ctx.orgId, never from the caller
 *  - owner_person_id is the acting person (auth.ctx.personId) on INSERT, never from the caller
 *  - created_by/updated_by are stamped by a DB trigger; this module never writes them
 *  - deletion is soft only (deleted_at = now()); there is no hard DELETE path
 *  - an UPDATE or soft-delete that touches zero rows is a NOT_FOUND through
 *    assertTargetAffected — the same concealment as an invisible target
 *
 * Track B specifics:
 *  - The (entity_type, entity_id) link is polymorphic with NO foreign key
 *    (migration 0034, plan §3). createActivity probes the referenced record for
 *    visibility (assertActivityReferences): an invisible reference — missing,
 *    deleted, or another tenant's — fails closed with NOT_FOUND concealment.
 *  - The link is immutable: UpdateActivitySchema carries no entityType/entityId,
 *    and the UPDATE column map has no entry for them.
 *  - entityName is resolved by conditional joins against all three CRM tables
 *    (only the arm matching entity_type can match), with org + liveness pinned.
 */

const SELECT_COLUMNS = sql`
  a.id,
  a.entity_type as "entityType",
  a.entity_id as "entityId",
  a.type,
  a.subject,
  a.notes,
  a.occurred_at::text as "occurredAt",
  a.due_at::text as "dueAt",
  coalesce(co.name, (ct.first_name || ' ' || ct.last_name), d.title) as "entityName",
  a.owner_person_id as "ownerPersonId",
  a.created_at as "createdAt",
  a.updated_at as "updatedAt"
`;

const FROM = sql`
  from public.activities a
  left join public.companies co
    on a.entity_type = 'company'
   and co.id = a.entity_id
   and co.org_id = a.org_id
   and co.deleted_at is null
  left join public.contacts ct
    on a.entity_type = 'contact'
   and ct.id = a.entity_id
   and ct.org_id = a.org_id
   and ct.deleted_at is null
  left join public.deals d
    on a.entity_type = 'deal'
   and d.id = a.entity_id
   and d.org_id = a.org_id
   and d.deleted_at is null
`;

const BASE_WHERE = (auth: Authorization) => sql`
  a.org_id = ${auth.ctx.orgId}::uuid
  and a.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE — the leading constant keeps the btree index on subject usable.
  return sql` and a.subject ilike ${search} || '%'`;
}

export async function listActivities(auth: Authorization, input: unknown): Promise<Page<Activity>> {
  const query: ListActivitiesQuery = ListActivitiesQuerySchema.parse(input);
  const entityTypeWhere = query.entityType ? sql` and a.entity_type = ${query.entityType}` : sql``;
  const entityIdWhere = query.entityId ? sql` and a.entity_id = ${query.entityId}::uuid` : sql``;
  const typeWhere = query.type ? sql` and a.type = ${query.type}` : sql``;
  const extraWhere = sql`${entityTypeWhere} ${entityIdWhere} ${typeWhere}`;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Activity>(sql`
        select ${SELECT_COLUMNS}
        ${FROM}
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${extraWhere}
        order by a.occurred_at desc nulls last, a.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.activities a
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${extraWhere}
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

export async function getActivity(auth: Authorization, id: string): Promise<Activity> {
  const activity = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Activity>(sql`
      select ${SELECT_COLUMNS}
      ${FROM}
      where ${BASE_WHERE(auth)}
        and a.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, activity ? 1 : 0);
  return activity as Activity;
}

export async function createActivity(auth: Authorization, input: unknown): Promise<Activity> {
  const data = CreateActivitySchema.parse(input);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    // The polymorphic link has no FK: the visibility probe is the enforcement
    // point. An invisible reference fails closed here, never as a 500.
    await assertActivityReferences(tx, auth, data.entityType, data.entityId);
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.activities (
        org_id, owner_person_id,
        entity_type, entity_id, type, subject, notes,
        occurred_at, due_at
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.entityType}, ${data.entityId}::uuid,
        ${data.type}, ${data.subject}, ${data.notes ?? null},
        ${data.occurredAt ?? null}::timestamptz,
        ${data.dueAt ?? null}::timestamptz
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Activity creation failed.');
    return row.id;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'activity.created',
      entityType: 'activity',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { type: data.type, entityType: data.entityType, entityId: data.entityId },
    },
    auth.meta,
  );
  return getActivity(auth, id);
}

const UPDATE_COLUMNS: Record<keyof UpdateActivityInput, string> = {
  type: 'type',
  subject: 'subject',
  notes: 'notes',
  occurredAt: 'occurred_at',
  dueAt: 'due_at',
};

export async function updateActivity(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<Activity> {
  const data = UpdateActivitySchema.parse(input);
  const sets = Object.entries(data).map(([key, value]) => {
    const column = UPDATE_COLUMNS[key as keyof UpdateActivityInput];
    if (column === 'occurred_at' || column === 'due_at')
      return sql`${sql.raw(column)} = ${value ?? null}::timestamptz`;
    return sql`${sql.raw(column)} = ${value ?? null}`;
  });
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.activities a
      set ${sql.join(sets, sql`, `)}, updated_at = now()
      where a.id = ${id}::uuid
        and ${BASE_WHERE(auth)}
      returning a.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'activity.updated',
      entityType: 'activity',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return getActivity(auth, id);
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function deleteActivity(auth: Authorization, id: string): Promise<void> {
  await softDeleteRow(
    auth,
    'activity',
    sql`public.activities a`,
    sql`a.id = ${id}::uuid and ${BASE_WHERE(auth)}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'activity.deleted',
      entityType: 'activity',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}
