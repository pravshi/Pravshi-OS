import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { writeAuditEntry } from '@/lib/audit/log';
import {
  CreateCompanySchema,
  ListQuerySchema,
  UpdateCompanySchema,
  type Company,
  type ListQuery,
  type Page,
  type UpdateCompanyInput,
} from './schema';

/**
 * Company service. Every function takes an Authorization that only requirePermission()
 * can issue, and runs its queries inside withAuthorizedDb() — the one path to Postgres.
 *
 * Trust boundaries, restated from the contract:
 *  - org_id always comes from auth.ctx.orgId, never from the caller
 *  - owner_person_id is the acting person (auth.ctx.personId) on INSERT, never from the caller
 *  - created_by/updated_by are stamped by a DB trigger; this module never writes them
 *  - deletion is soft only (deleted_at = now()); there is no hard DELETE path
 *  - an UPDATE or soft-delete that touches zero rows is a NOT_FOUND through
 *    assertTargetAffected — the same concealment as an invisible target
 */

const SELECT_COLUMNS = sql`
  c.id,
  c.name,
  c.domain,
  c.industry,
  c.size,
  c.website,
  c.phone,
  c.address_line1 as "addressLine1",
  c.address_line2 as "addressLine2",
  c.address_city as "addressCity",
  c.address_state as "addressState",
  c.address_postal_code as "addressPostalCode",
  c.country_code as "countryCode",
  c.owner_person_id as "ownerPersonId",
  c.created_at as "createdAt",
  c.updated_at as "updatedAt"
`;

const BASE_WHERE = (auth: Authorization) => sql`
  c.org_id = ${auth.ctx.orgId}::uuid
  and c.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE — the leading constant keeps the btree index on name usable.
  return sql` and c.name ilike ${search} || '%'`;
}

export async function listCompanies(auth: Authorization, input: unknown): Promise<Page<Company>> {
  const query: ListQuery = ListQuerySchema.parse(input);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Company>(sql`
        select ${SELECT_COLUMNS}
        from public.companies c
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)}
        order by c.name asc, c.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.companies c
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)}
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

export async function getCompany(auth: Authorization, id: string): Promise<Company> {
  const company = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Company>(sql`
      select ${SELECT_COLUMNS}
      from public.companies c
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, company ? 1 : 0);
  return company as Company;
}

export async function createCompany(auth: Authorization, input: unknown): Promise<Company> {
  const data = CreateCompanySchema.parse(input);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.companies (
        org_id, owner_person_id,
        name, domain, industry, size, website, phone,
        address_line1, address_line2, address_city, address_state,
        address_postal_code, country_code
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.name}, ${data.domain ?? null}, ${data.industry ?? null},
        ${data.size ?? null}, ${data.website ?? null}, ${data.phone ?? null},
        ${data.addressLine1 ?? null}, ${data.addressLine2 ?? null},
        ${data.addressCity ?? null}, ${data.addressState ?? null},
        ${data.addressPostalCode ?? null}, ${data.countryCode ?? null}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Company creation failed.');
    return row.id;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'company.created',
      entityType: 'company',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { name: data.name },
    },
    auth.meta,
  );
  return getCompany(auth, id);
}

const UPDATE_COLUMNS: Record<keyof UpdateCompanyInput, string> = {
  name: 'name',
  domain: 'domain',
  industry: 'industry',
  size: 'size',
  website: 'website',
  phone: 'phone',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  addressCity: 'address_city',
  addressState: 'address_state',
  addressPostalCode: 'address_postal_code',
  countryCode: 'country_code',
};

export async function updateCompany(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<Company> {
  const data = UpdateCompanySchema.parse(input);
  const sets = Object.entries(data).map(
    ([key, value]) =>
      sql`${sql.raw(UPDATE_COLUMNS[key as keyof UpdateCompanyInput])} = ${value ?? null}`,
  );
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.companies c
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
      action: 'company.updated',
      entityType: 'company',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return getCompany(auth, id);
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function deleteCompany(auth: Authorization, id: string): Promise<void> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.companies c
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
      action: 'company.deleted',
      entityType: 'company',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}
