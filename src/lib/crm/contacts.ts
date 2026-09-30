import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertCompanyVisible } from './refs';
import {
  CreateContactSchema,
  ListContactsQuerySchema,
  UpdateContactSchema,
  type Contact,
  type ListContactsQuery,
  type Page,
  type UpdateContactInput,
} from './schema';

/**
 * Contact service. Same trust boundaries as companies.ts:
 * org_id from auth.ctx.orgId, owner_person_id from auth.ctx.personId on INSERT,
 * created_by/updated_by stamped by trigger (never written here), soft delete only.
 */

const SELECT_COLUMNS = sql`
  c.id,
  c.company_id as "companyId",
  co.name as "companyName",
  c.first_name as "firstName",
  c.last_name as "lastName",
  c.email,
  c.phone,
  c.title,
  c.department,
  c.owner_person_id as "ownerPersonId",
  c.created_at as "createdAt",
  c.updated_at as "updatedAt"
`;

const FROM = sql`
  from public.contacts c
  left join public.companies co
    on co.id = c.company_id
   and co.org_id = c.org_id
   and co.deleted_at is null
`;

const BASE_WHERE = (auth: Authorization) => sql`
  c.org_id = ${auth.ctx.orgId}::uuid
  and c.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE on name and email — the leading constants keep the btree indexes usable.
  return sql` and (
    (c.first_name || ' ' || c.last_name) ilike ${search} || '%'
    or c.email ilike ${search} || '%'
  )`;
}

export async function listContacts(auth: Authorization, input: unknown): Promise<Page<Contact>> {
  const query: ListContactsQuery = ListContactsQuerySchema.parse(input);
  // U3: server-side related-record filter (replaces client-side filtering of a
  // capped list on detail pages).
  const companyWhere = query.companyId ? sql` and c.company_id = ${query.companyId}::uuid` : sql``;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Contact>(sql`
        select ${SELECT_COLUMNS}
        ${FROM}
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${companyWhere}
        order by c.last_name asc, c.first_name asc, c.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.contacts c
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${companyWhere}
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

export async function getContact(auth: Authorization, id: string): Promise<Contact> {
  const contact = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Contact>(sql`
      select ${SELECT_COLUMNS}
      ${FROM}
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, contact ? 1 : 0);
  return contact as Contact;
}

export async function createContact(auth: Authorization, input: unknown): Promise<Contact> {
  const data = CreateContactSchema.parse(input);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    // A1: the referenced company must be visible in the caller's org — a
    // cross-tenant UUID fails closed here, not as a 500 FK violation.
    if (data.companyId) await assertCompanyVisible(tx, auth, data.companyId);
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.contacts (
        org_id, owner_person_id,
        company_id, first_name, last_name, email, phone, title, department
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.companyId ?? null}::uuid,
        ${data.firstName}, ${data.lastName},
        ${data.email ?? null}, ${data.phone ?? null},
        ${data.title ?? null}, ${data.department ?? null}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Contact creation failed.');
    return row.id;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'contact.created',
      entityType: 'contact',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { name: `${data.firstName} ${data.lastName}` },
    },
    auth.meta,
  );
  return getContact(auth, id);
}

const UPDATE_COLUMNS: Record<keyof UpdateContactInput, string> = {
  companyId: 'company_id',
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  title: 'title',
  department: 'department',
};

export async function updateContact(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<Contact> {
  const data = UpdateContactSchema.parse(input);
  const sets = Object.entries(data).map(([key, value]) => {
    const column = UPDATE_COLUMNS[key as keyof UpdateContactInput];
    if (column === 'company_id') return sql`${sql.raw(column)} = ${value ?? null}::uuid`;
    return sql`${sql.raw(column)} = ${value ?? null}`;
  });
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    // A1: probe a newly linked company before the update.
    if (data.companyId) await assertCompanyVisible(tx, auth, data.companyId);
    const res = await tx.execute(sql`
      update public.contacts c
      set ${sql.join(sets, sql`, `)}, updated_at = now()
      where c.id = ${id}::uuid
        and ${BASE_WHERE(auth)}
      returning c.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return getContact(auth, id);
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function deleteContact(auth: Authorization, id: string): Promise<void> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.contacts c
      set deleted_at = now(), updated_at = now()
      where c.id = ${id}::uuid
        and ${BASE_WHERE(auth)}
      returning c.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'contact.deleted',
      entityType: 'contact',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}
