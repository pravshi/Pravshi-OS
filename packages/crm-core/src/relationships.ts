import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { softDeleteRow } from './soft-delete';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertCompanyVisible, assertContactVisible } from './refs';
import {
  CreateCompanyContactSchema,
  CreateCompanyLinkSchema,
  CreateContactLinkSchema,
  ListQuerySchema,
  UpdateCompanyContactSchema,
  type CompanyContact,
  type CompanyLink,
  type ContactLink,
  type ListQuery,
  type Page,
} from './schema';

/**
 * Relationships service: the explicit join tables between CRM core records
 * (migration 0035 — company_contacts, company_links, contact_links).
 *
 * The same trust boundaries as companies.ts:
 *  - org_id always comes from auth.ctx.orgId, never from the caller
 *  - owner_person_id is the acting person (auth.ctx.personId) on INSERT, never from the caller
 *  - created_by/updated_by are stamped by a DB trigger; this module never writes them
 *  - deletion is soft only (deleted_at = now()); there is no hard DELETE path
 *  - an UPDATE or soft-delete that touches zero rows is a NOT_FOUND through
 *    assertTargetAffected — the same concealment as an invisible target
 *  - both endpoints of a relationship are probed for visibility before any write
 *    (refs.ts — the same NOT_FOUND concealment as contacts/deals), so a cross-tenant
 *    UUID fails closed instead of surfacing a 500 FK violation oracle
 *
 * There are NO REST routes for relationships: association operations are
 * transactional multi-probe operations with no external HTTP consumer; the UI uses
 * server actions only (the Phase 2 contract allows omitting routes where no real
 * HTTP surface is needed).
 *
 * Wire contract: the API speaks camelCase; SQL aliases translate at the boundary.
 */

// ── Company contacts ─────────────────────────────────────────────────────────────

const COMPANY_CONTACT_COLUMNS = sql`
  cc.id,
  cc.company_id as "companyId",
  cc.contact_id as "contactId",
  cc.role,
  cc.is_primary as "isPrimary",
  cc.owner_person_id as "ownerPersonId",
  cc.created_at as "createdAt",
  cc.updated_at as "updatedAt",
  null::text as "companyName"
`;

const BASE_WHERE = (auth: Authorization, alias: string) => sql`
  ${sql.raw(alias)}.org_id = ${auth.ctx.orgId}::uuid
  and ${sql.raw(alias)}.deleted_at is null
`;

/** Associations for one company: joins the contact for display. */
export async function listCompanyContacts(
  auth: Authorization,
  companyId: string,
  input: unknown,
): Promise<Page<CompanyContact>> {
  const query: ListQuery = ListQuerySchema.parse(input);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertCompanyVisible(tx, auth, companyId);
  });
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<CompanyContact>(sql`
        select ${COMPANY_CONTACT_COLUMNS},
               c.first_name || ' ' || coalesce(c.last_name, '') as "contactName",
               c.email as "contactEmail"
        from public.company_contacts cc
        join public.contacts c
          on c.id = cc.contact_id and c.org_id = cc.org_id and c.deleted_at is null
        where ${BASE_WHERE(auth, 'cc')} and cc.company_id = ${companyId}::uuid
        order by cc.is_primary desc, c.first_name asc, c.last_name asc, cc.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.company_contacts cc
        where ${BASE_WHERE(auth, 'cc')} and cc.company_id = ${companyId}::uuid
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

/** Associations for one contact: joins the company for display. */
export async function listContactAssociations(
  auth: Authorization,
  contactId: string,
  input: unknown,
): Promise<Page<CompanyContact>> {
  const query: ListQuery = ListQuerySchema.parse(input);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertContactVisible(tx, auth, contactId);
  });
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<CompanyContact>(sql`
        select cc.id,
               cc.company_id as "companyId",
               cc.contact_id as "contactId",
               cc.role,
               cc.is_primary as "isPrimary",
               cc.owner_person_id as "ownerPersonId",
               cc.created_at as "createdAt",
               cc.updated_at as "updatedAt",
               c.name as "companyName",
               null::text as "contactName",
               null::text as "contactEmail"
        from public.company_contacts cc
        join public.companies c
          on c.id = cc.company_id and c.org_id = cc.org_id and c.deleted_at is null
        where ${BASE_WHERE(auth, 'cc')} and cc.contact_id = ${contactId}::uuid
        order by cc.is_primary desc, c.name asc, cc.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.company_contacts cc
        where ${BASE_WHERE(auth, 'cc')} and cc.contact_id = ${contactId}::uuid
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

async function getCompanyContact(tx: Tx, auth: Authorization, id: string) {
  const res = await tx.execute<CompanyContact>(sql`
    select ${COMPANY_CONTACT_COLUMNS},
           c.first_name || ' ' || coalesce(c.last_name, '') as "contactName",
           c.email as "contactEmail"
    from public.company_contacts cc
    join public.contacts c
      on c.id = cc.contact_id and c.org_id = cc.org_id and c.deleted_at is null
    where ${BASE_WHERE(auth, 'cc')} and cc.id = ${id}::uuid
  `);
  return res.rows[0] ?? null;
}

/**
 * Create a contact↔company association. If a live association already exists
 * for the pair it is updated in place (role/isPrimary) — re-linking is
 * idempotent; a soft-deleted pair starts fresh. The create action gates on
 * relationships.create; the update action on relationships.edit.
 *
 * Setting isPrimary clears the flag on every other live association for that
 * company AND that contact, inside the same transaction — the unique partial
 * indexes are the backstop, this is the friendly write path.
 */
export async function createCompanyContact(
  auth: Authorization,
  input: unknown,
): Promise<CompanyContact> {
  const data = CreateCompanyContactSchema.parse(input);
  const { id, updated } = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertCompanyVisible(tx, auth, data.companyId);
    await assertContactVisible(tx, auth, data.contactId);

    const existing = await tx.execute<{ id: string }>(sql`
      select cc.id
      from public.company_contacts cc
      where ${BASE_WHERE(auth, 'cc')}
        and cc.company_id = ${data.companyId}::uuid
        and cc.contact_id = ${data.contactId}::uuid
    `);
    const rowId = existing.rows[0]?.id;

    if (data.isPrimary) {
      await tx.execute(sql`
        update public.company_contacts cc
        set is_primary = false, updated_at = now()
        where ${BASE_WHERE(auth, 'cc')}
          and (cc.company_id = ${data.companyId}::uuid
               or cc.contact_id = ${data.contactId}::uuid)
          and cc.is_primary
      `);
    }

    if (rowId) {
      await tx.execute(sql`
        update public.company_contacts cc
        set role = ${data.role ?? null},
            is_primary = ${data.isPrimary},
            updated_at = now()
        where cc.id = ${rowId}::uuid
          and ${BASE_WHERE(auth, 'cc')}
      `);
      return { id: rowId, updated: true };
    }

    const res = await tx.execute<{ id: string }>(sql`
      insert into public.company_contacts (
        org_id, owner_person_id, company_id, contact_id, role, is_primary
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.companyId}::uuid, ${data.contactId}::uuid,
        ${data.role ?? null}, ${data.isPrimary}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Association creation failed.');
    return { id: row.id, updated: false };
  });

  await writeAuditEntry(
    auth.ctx,
    {
      action: updated ? 'company_contact.updated' : 'company_contact.created',
      entityType: 'company_contact',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { companyId: data.companyId, contactId: data.contactId },
    },
    auth.meta,
  );

  const row = await withAuthorizedDb(auth.ctx, (tx) => getCompanyContact(tx, auth, id));
  await assertTargetAffected(auth, row ? 1 : 0);
  return row as CompanyContact;
}

/**
 * Update an existing association's role/isPrimary. Gated on relationships.edit
 * by the calling action; a missing or invisible pair is NOT_FOUND concealment.
 */
export async function updateCompanyContact(
  auth: Authorization,
  companyId: string,
  contactId: string,
  input: unknown,
): Promise<CompanyContact> {
  const data = UpdateCompanyContactSchema.parse(input);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertCompanyVisible(tx, auth, companyId);
    await assertContactVisible(tx, auth, contactId);

    if (data.isPrimary === true) {
      await tx.execute(sql`
        update public.company_contacts cc
        set is_primary = false, updated_at = now()
        where ${BASE_WHERE(auth, 'cc')}
          and (cc.company_id = ${companyId}::uuid
               or cc.contact_id = ${contactId}::uuid)
          and cc.is_primary
      `);
    }

    const sets = Object.entries(data).map(([key, value]) =>
      key === 'role' ? sql`role = ${value ?? null}` : sql`is_primary = ${value ?? false}`,
    );
    const res = await tx.execute<{ id: string }>(sql`
      update public.company_contacts cc
      set ${sql.join(sets, sql`, `)}, updated_at = now()
      where cc.company_id = ${companyId}::uuid
        and cc.contact_id = ${contactId}::uuid
        and ${BASE_WHERE(auth, 'cc')}
      returning cc.id
    `);
    const row = res.rows[0];
    await assertTargetAffected(auth, row ? 1 : 0);
    return (row as { id: string }).id;
  });

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'company_contact.updated',
      entityType: 'company_contact',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { companyId, contactId, fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );

  const row = await withAuthorizedDb(auth.ctx, (tx) => getCompanyContact(tx, auth, id));
  await assertTargetAffected(auth, row ? 1 : 0);
  return row as CompanyContact;
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function removeCompanyContact(
  auth: Authorization,
  companyId: string,
  contactId: string,
): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertCompanyVisible(tx, auth, companyId);
    await assertContactVisible(tx, auth, contactId);
  });
  await softDeleteRow(
    auth,
    'company_contact',
    sql`public.company_contacts cc`,
    sql`cc.company_id = ${companyId}::uuid
      and cc.contact_id = ${contactId}::uuid
      and ${BASE_WHERE(auth, 'cc')}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'company_contact.deleted',
      entityType: 'company_contact',
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: { companyId, contactId },
    },
    auth.meta,
  );
}

// ── Company links ────────────────────────────────────────────────────────────────

const COMPANY_LINK_COLUMNS = sql`
  cl.id,
  cl.from_company_id as "fromCompanyId",
  cl.to_company_id as "toCompanyId",
  cl.link_type as "linkType",
  cl.owner_person_id as "ownerPersonId",
  cl.created_at as "createdAt",
  cl.updated_at as "updatedAt"
`;

/** Links where the company is either endpoint; the other side's name is joined. */
export async function listCompanyLinks(
  auth: Authorization,
  companyId: string,
  input: unknown,
): Promise<Page<CompanyLink>> {
  const query: ListQuery = ListQuerySchema.parse(input);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertCompanyVisible(tx, auth, companyId);
  });
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const side = (row: CompanyLink) => (row.fromCompanyId === companyId ? 'outgoing' : 'incoming');
    const [rows, counts] = await Promise.all([
      tx.execute<CompanyLink & { otherName: string }>(sql`
        select ${COMPANY_LINK_COLUMNS},
               case
                 when cl.from_company_id = ${companyId}::uuid then oc_to.name
                 else oc_from.name
               end as "otherName"
        from public.company_links cl
        join public.companies oc_from
          on oc_from.id = cl.from_company_id and oc_from.org_id = cl.org_id
             and oc_from.deleted_at is null
        join public.companies oc_to
          on oc_to.id = cl.to_company_id and oc_to.org_id = cl.org_id
             and oc_to.deleted_at is null
        where ${BASE_WHERE(auth, 'cl')}
          and (cl.from_company_id = ${companyId}::uuid
               or cl.to_company_id = ${companyId}::uuid)
        order by cl.created_at desc, cl.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.company_links cl
        where ${BASE_WHERE(auth, 'cl')}
          and (cl.from_company_id = ${companyId}::uuid
               or cl.to_company_id = ${companyId}::uuid)
      `),
    ]);
    const enriched = rows.rows.map((r) => ({
      ...r,
      direction: side(r) as 'outgoing' | 'incoming',
    }));
    return {
      rows: enriched,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

async function getCompanyLink(tx: Tx, auth: Authorization, id: string) {
  const res = await tx.execute<CompanyLink>(sql`
    select ${COMPANY_LINK_COLUMNS}
    from public.company_links cl
    where ${BASE_WHERE(auth, 'cl')} and cl.id = ${id}::uuid
  `);
  return res.rows[0] ?? null;
}

export async function createCompanyLink(auth: Authorization, input: unknown): Promise<CompanyLink> {
  const data = CreateCompanyLinkSchema.parse(input);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertCompanyVisible(tx, auth, data.fromCompanyId);
    await assertCompanyVisible(tx, auth, data.toCompanyId);
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.company_links (
        org_id, owner_person_id, from_company_id, to_company_id, link_type
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.fromCompanyId}::uuid, ${data.toCompanyId}::uuid,
        ${data.linkType}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Company link creation failed.');
    return row.id;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'company_link.created',
      entityType: 'company_link',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: {
        fromCompanyId: data.fromCompanyId,
        toCompanyId: data.toCompanyId,
        linkType: data.linkType,
      },
    },
    auth.meta,
  );
  const row = await withAuthorizedDb(auth.ctx, (tx) => getCompanyLink(tx, auth, id));
  await assertTargetAffected(auth, row ? 1 : 0);
  return row as CompanyLink;
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function removeCompanyLink(auth: Authorization, id: string): Promise<void> {
  await softDeleteRow(
    auth,
    'company_link',
    sql`public.company_links cl`,
    sql`cl.id = ${id}::uuid and ${BASE_WHERE(auth, 'cl')}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'company_link.deleted',
      entityType: 'company_link',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}

// ── Contact links ────────────────────────────────────────────────────────────────

const CONTACT_LINK_COLUMNS = sql`
  cl.id,
  cl.from_contact_id as "fromContactId",
  cl.to_contact_id as "toContactId",
  cl.link_type as "linkType",
  cl.owner_person_id as "ownerPersonId",
  cl.created_at as "createdAt",
  cl.updated_at as "updatedAt"
`;

/** Links where the contact is either endpoint; the other side's name is joined. */
export async function listContactLinks(
  auth: Authorization,
  contactId: string,
  input: unknown,
): Promise<Page<ContactLink>> {
  const query: ListQuery = ListQuerySchema.parse(input);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertContactVisible(tx, auth, contactId);
  });
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const side = (row: ContactLink) => (row.fromContactId === contactId ? 'outgoing' : 'incoming');
    const [rows, counts] = await Promise.all([
      tx.execute<ContactLink & { otherName: string }>(sql`
        select ${CONTACT_LINK_COLUMNS},
               case
                 when cl.from_contact_id = ${contactId}::uuid
                   then oc_to.first_name || ' ' || coalesce(oc_to.last_name, '')
                 else oc_from.first_name || ' ' || coalesce(oc_from.last_name, '')
               end as "otherName"
        from public.contact_links cl
        join public.contacts oc_from
          on oc_from.id = cl.from_contact_id and oc_from.org_id = cl.org_id
             and oc_from.deleted_at is null
        join public.contacts oc_to
          on oc_to.id = cl.to_contact_id and oc_to.org_id = cl.org_id
             and oc_to.deleted_at is null
        where ${BASE_WHERE(auth, 'cl')}
          and (cl.from_contact_id = ${contactId}::uuid
               or cl.to_contact_id = ${contactId}::uuid)
        order by cl.created_at desc, cl.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.contact_links cl
        where ${BASE_WHERE(auth, 'cl')}
          and (cl.from_contact_id = ${contactId}::uuid
               or cl.to_contact_id = ${contactId}::uuid)
      `),
    ]);
    const enriched = rows.rows.map((r) => ({
      ...r,
      direction: side(r) as 'outgoing' | 'incoming',
    }));
    return {
      rows: enriched,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

async function getContactLink(tx: Tx, auth: Authorization, id: string) {
  const res = await tx.execute<ContactLink>(sql`
    select ${CONTACT_LINK_COLUMNS}
    from public.contact_links cl
    where ${BASE_WHERE(auth, 'cl')} and cl.id = ${id}::uuid
  `);
  return res.rows[0] ?? null;
}

export async function createContactLink(auth: Authorization, input: unknown): Promise<ContactLink> {
  const data = CreateContactLinkSchema.parse(input);
  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertContactVisible(tx, auth, data.fromContactId);
    await assertContactVisible(tx, auth, data.toContactId);
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.contact_links (
        org_id, owner_person_id, from_contact_id, to_contact_id, link_type
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.fromContactId}::uuid, ${data.toContactId}::uuid,
        ${data.linkType}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Contact link creation failed.');
    return row.id;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'contact_link.created',
      entityType: 'contact_link',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: {
        fromContactId: data.fromContactId,
        toContactId: data.toContactId,
        linkType: data.linkType,
      },
    },
    auth.meta,
  );
  const row = await withAuthorizedDb(auth.ctx, (tx) => getContactLink(tx, auth, id));
  await assertTargetAffected(auth, row ? 1 : 0);
  return row as ContactLink;
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function removeContactLink(auth: Authorization, id: string): Promise<void> {
  await softDeleteRow(
    auth,
    'contact_link',
    sql`public.contact_links cl`,
    sql`cl.id = ${id}::uuid and ${BASE_WHERE(auth, 'cl')}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'contact_link.deleted',
      entityType: 'contact_link',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}
