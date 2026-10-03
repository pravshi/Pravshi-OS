import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { writeAuditEntry } from '@/lib/audit/log';
import { isPgCode, parseRequest } from './errors';
import {
  AddProjectMemberSchema,
  CreateProjectSchema,
  LinkDealSchema,
  ListProjectsQuerySchema,
  UpdateProjectSchema,
  type DealLinkSummary,
  type ListProjectsQuery,
  type Page,
  type Project,
  type ProjectLinkSummary,
  type ProjectListRow,
  type ProjectMember,
  type ProjectSortField,
} from './schema';

/**
 * Project service (Phase 4). Trust boundaries:
 *
 *  - org_id always comes from auth.ctx.orgId, never from the caller; every
 *    query re-states the org predicate explicitly (defense in depth over RLS)
 *  - created_by is stamped from auth.ctx.personId on insert, never from the body
 *  - projects are archived, never deleted: archiveProject()/unarchiveProject()
 *    flip is_archived. There is no project delete path (DELETE
 *    /api/work/projects/[id] maps to archive)
 *  - an UPDATE or archive that touches zero rows is NOT_FOUND through
 *    assertTargetAffected — the same concealment as an invisible target
 *  - permission keys are the exact 0008 seed keys (projects.view / create /
 *    edit / delete / manage_members); the routes own the key choice
 *
 * Project members: the project_members table (migration 0042, per blueprint
 * §15: project_id, person_id, role_in_project, added_by, added_at) is the
 * backbone of PROJECT-scoped access. Membership changes are audited.
 * Add/remove are gated by projects.manage_members at the route.
 */

const PROJECT_COLUMNS = sql`
  p.id,
  p.name,
  p.description,
  p.is_archived as "isArchived",
  p.deal_id as "dealId",
  p.created_by as "createdBy",
  p.created_at as "createdAt",
  p.updated_at as "updatedAt"
`;

const PROJECT_WHERE = (auth: Authorization) => sql`
  p.org_id = ${auth.ctx.orgId}::uuid
  and p.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE — the leading constant keeps the btree index on name usable.
  return sql` and p.name ilike ${search} || '%'`;
}

function projectSortSql(sort: ProjectSortField, order: 'asc' | 'desc'): SQL {
  // sort/order come from the zod allowlist — never raw caller text.
  const dir = order === 'asc' ? sql`asc` : sql`desc`;
  switch (sort) {
    case 'name':
      return sql`p.name ${dir}, p.id asc`;
    case 'createdAt':
      return sql`p.created_at ${dir}, p.id asc`;
    case 'updatedAt':
      return sql`p.updated_at ${dir}, p.id asc`;
  }
}

/** Map a projects 23505 to the 400 it deserves; anything else rethrows. */
function invalidProjectConflict(error: unknown): never {
  if (isPgCode(error, '23505')) {
    throw new Error('INVALID_REQUEST: a project with these details already exists');
  }
  throw error;
}

/** The named project must be live and visible in the caller's org. */
async function assertProjectVisible(tx: Tx, auth: Authorization, projectId: string): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.work_projects p
    where p.id = ${projectId}::uuid
      and ${PROJECT_WHERE(auth)}
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

export async function listProjects(
  auth: Authorization,
  input: unknown,
): Promise<Page<ProjectListRow>> {
  const query: ListProjectsQuery = parseRequest(ListProjectsQuerySchema, input ?? {});
  const archivedWhere = query.includeArchived ? sql`` : sql` and p.is_archived = false`;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<ProjectListRow>(sql`
        select ${PROJECT_COLUMNS},
          (select count(*)::int
             from public.work_tasks t
            where t.project_id = p.id
              and t.org_id = p.org_id
              and t.deleted_at is null) as "taskCount",
          (select count(*)::int
             from public.work_tasks t
            where t.project_id = p.id
              and t.org_id = p.org_id
              and t.deleted_at is null
              and t.status <> 'done') as "openTaskCount"
        from public.work_projects p
        where ${PROJECT_WHERE(auth)} ${searchWhere(query.search)} ${archivedWhere}
        order by ${projectSortSql(query.sort, query.order)}
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.work_projects p
        where ${PROJECT_WHERE(auth)} ${searchWhere(query.search)} ${archivedWhere}
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

export async function getProject(auth: Authorization, id: string): Promise<Project> {
  const project = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Project>(sql`
      select ${PROJECT_COLUMNS}
      from public.work_projects p
      where ${PROJECT_WHERE(auth)}
        and p.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, project ? 1 : 0);
  return project as Project;
}

export async function createProject(auth: Authorization, input: unknown): Promise<Project> {
  const data = parseRequest(CreateProjectSchema, input);
  let id: string;
  try {
    id = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        insert into public.work_projects (org_id, name, description, created_by)
        values (
          ${auth.ctx.orgId}::uuid,
          ${data.name},
          ${data.description ?? null},
          ${auth.ctx.personId}::uuid
        )
        returning id
      `);
      const row = res.rows[0];
      if (!row) throw new Error('Project creation failed.');
      return row.id;
    });
  } catch (error) {
    invalidProjectConflict(error);
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'project.created',
      entityType: 'project',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { name: data.name },
    },
    auth.meta,
  );
  return getProject(auth, id);
}

export async function updateProject(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<Project> {
  const data = parseRequest(UpdateProjectSchema, input);
  try {
    const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
      const sets: SQL[] = [];
      if (data.name !== undefined) sets.push(sql`name = ${data.name}`);
      if (data.description !== undefined) sets.push(sql`description = ${data.description}`);
      const res = await tx.execute(sql`
        update public.work_projects p
        set ${sql.join(sets, sql`, `)}, updated_at = now()
        where p.id = ${id}::uuid
          and ${PROJECT_WHERE(auth)}
        returning p.id
      `);
      return res.rowCount ?? 0;
    });
    await assertTargetAffected(auth, affected);
  } catch (error) {
    invalidProjectConflict(error);
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'project.updated',
      entityType: 'project',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return getProject(auth, id);
}

async function setProjectArchived(
  auth: Authorization,
  id: string,
  archived: boolean,
): Promise<Project> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.work_projects p
      set is_archived = ${archived}, updated_at = now()
      where p.id = ${id}::uuid
        and ${PROJECT_WHERE(auth)}
      returning p.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: archived ? 'project.archived' : 'project.unarchived',
      entityType: 'project',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: {},
    },
    auth.meta,
  );
  return getProject(auth, id);
}

/** Archive only: sets is_archived. There is no project hard-delete path. */
export async function archiveProject(auth: Authorization, id: string): Promise<Project> {
  return setProjectArchived(auth, id, true);
}

export async function unarchiveProject(auth: Authorization, id: string): Promise<Project> {
  return setProjectArchived(auth, id, false);
}

// ── Project members ─────────────────────────────────────────────────────────────

const MEMBER_COLUMNS = sql`
  pm.person_id as "personId",
  coalesce(per.preferred_name, per.full_legal_name) as name,
  per.work_email as "workEmail",
  pm.role_in_project as "roleInProject",
  pm.added_by as "addedBy",
  pm.added_at as "addedAt"
`;

/** The person must be live and visible in the caller's org (people RLS:
 *  org isolation + liveness + people.view scope apply inside the probe). */
async function assertPersonVisible(tx: Tx, auth: Authorization, personId: string): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.people per
    where per.id = ${personId}::uuid
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

export async function listProjectMembers(
  auth: Authorization,
  projectId: string,
): Promise<ProjectMember[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertProjectVisible(tx, auth, projectId);
    const res = await tx.execute<ProjectMember>(sql`
      select ${MEMBER_COLUMNS}
      from public.project_members pm
      join public.people per
        on per.id = pm.person_id
      where pm.project_id = ${projectId}::uuid
        and pm.org_id = ${auth.ctx.orgId}::uuid
      order by pm.added_at asc, pm.person_id asc
    `);
    return res.rows;
  });
}

export async function addProjectMember(
  auth: Authorization,
  projectId: string,
  input: unknown,
): Promise<ProjectMember[]> {
  const data = parseRequest(AddProjectMemberSchema, input);
  try {
    await withAuthorizedDb(auth.ctx, async (tx) => {
      await assertProjectVisible(tx, auth, projectId);
      await assertPersonVisible(tx, auth, data.personId);
      // role_in_project is written only when the caller supplies it, so a
      // database default applies otherwise.
      const columns = ['org_id', 'project_id', 'person_id', 'added_by'];
      const values: SQL[] = [
        sql`${auth.ctx.orgId}::uuid`,
        sql`${projectId}::uuid`,
        sql`${data.personId}::uuid`,
        sql`${auth.ctx.personId}::uuid`,
      ];
      if (data.roleInProject !== undefined) {
        columns.push('role_in_project');
        values.push(sql`${data.roleInProject}`);
      }
      await tx.execute(sql`
        insert into public.project_members (${sql.join(
          columns.map((c) => sql.raw(c)),
          sql`, `,
        )})
        values (${sql.join(values, sql`, `)})
      `);
    });
  } catch (error) {
    if (isPgCode(error, '23505')) {
      throw new Error('INVALID_REQUEST: this person is already a member of the project');
    }
    if (isPgCode(error, '23503')) {
      throw new Error('INVALID_REQUEST: unknown project or person');
    }
    if (isPgCode(error, '23502')) {
      throw new Error('INVALID_REQUEST: roleInProject is required');
    }
    throw error;
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'project.member_added',
      entityType: 'project',
      entityId: projectId,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: {
        personId: data.personId,
        roleInProject: data.roleInProject ?? null,
        actorPersonId: auth.ctx.personId,
      },
    },
    auth.meta,
  );
  return listProjectMembers(auth, projectId);
}

export async function removeProjectMember(
  auth: Authorization,
  projectId: string,
  personId: string,
): Promise<void> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertProjectVisible(tx, auth, projectId);
    const res = await tx.execute(sql`
      delete from public.project_members pm
      where pm.project_id = ${projectId}::uuid
        and pm.person_id = ${personId}::uuid
        and pm.org_id = ${auth.ctx.orgId}::uuid
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'project.member_removed',
      entityType: 'project',
      entityId: projectId,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { personId, actorPersonId: auth.ctx.personId },
    },
    auth.meta,
  );
}

// ── Deal ↔ project link ──────────────────────────────────────────────────────
// Deal → Project → Tasks: the CRM integration seam. One deal links to at most
// one live project per org (enforced here; the DB has a partial unique index).

const DEAL_SUMMARY_COLUMNS = sql`
  d.id,
  d.title,
  d.value::text as value,
  d.currency,
  d.stage
`;

/**
 * The deal must be live and in the caller's org. A deal the caller cannot see
 * is an actionable 400 INVALID_REQUEST, never a silent 404.
 */
async function assertDealVisible(tx: Tx, auth: Authorization, dealId: string): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.deals d
    where d.id = ${dealId}::uuid
      and d.org_id = ${auth.ctx.orgId}::uuid
      and d.deleted_at is null
  `);
  if ((res.rowCount ?? 0) === 0) {
    throw new Error('INVALID_REQUEST: deal not found in your organization');
  }
}

/** Link a project to the CRM deal it delivers. */
export async function linkProjectToDeal(
  auth: Authorization,
  projectId: string,
  input: unknown,
): Promise<DealLinkSummary> {
  const data = parseRequest(LinkDealSchema, input);
  let summary: DealLinkSummary;
  try {
    summary = await withAuthorizedDb(auth.ctx, async (tx) => {
      await assertProjectVisible(tx, auth, projectId);
      await assertDealVisible(tx, auth, data.dealId);
      // One deal → one project: the org's other live projects may not hold it.
      const clash = await tx.execute(sql`
        select 1
        from public.work_projects p
        where p.deal_id = ${data.dealId}::uuid
          and p.org_id = ${auth.ctx.orgId}::uuid
          and p.deleted_at is null
          and p.id <> ${projectId}::uuid
      `);
      if ((clash.rowCount ?? 0) > 0) {
        throw new Error('INVALID_REQUEST: this deal is already linked to a project');
      }
      const res = await tx.execute(sql`
        update public.work_projects p
        set deal_id = ${data.dealId}::uuid, updated_at = now()
        where p.id = ${projectId}::uuid
          and ${PROJECT_WHERE(auth)}
        returning p.id
      `);
      await assertTargetAffected(auth, res.rowCount ?? 0);
      const deal = await tx.execute<DealLinkSummary>(sql`
        select ${DEAL_SUMMARY_COLUMNS}
        from public.deals d
        where d.id = ${data.dealId}::uuid
      `);
      const row = deal.rows[0];
      if (!row) throw new Error('INVALID_REQUEST: deal not found in your organization');
      return row;
    });
  } catch (error) {
    if (isPgCode(error, '42501')) {
      throw new Error('INVALID_REQUEST: deal not found in your organization');
    }
    throw error;
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'project.deal_linked',
      entityType: 'project',
      entityId: projectId,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { dealId: data.dealId, actorPersonId: auth.ctx.personId },
    },
    auth.meta,
  );
  return summary;
}

/** Clear a project's deal link. Idempotent: already-unlinked is still 200. */
export async function unlinkProjectFromDeal(auth: Authorization, projectId: string): Promise<void> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertProjectVisible(tx, auth, projectId);
    const res = await tx.execute(sql`
      update public.work_projects p
      set deal_id = null, updated_at = now()
      where p.id = ${projectId}::uuid
        and ${PROJECT_WHERE(auth)}
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'project.deal_unlinked',
      entityType: 'project',
      entityId: projectId,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { actorPersonId: auth.ctx.personId },
    },
    auth.meta,
  );
}

/** The deal linked to a project, or null when none is linked. */
export async function getProjectDeal(
  auth: Authorization,
  projectId: string,
): Promise<DealLinkSummary | null> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertProjectVisible(tx, auth, projectId);
    const res = await tx.execute<DealLinkSummary>(sql`
      select ${DEAL_SUMMARY_COLUMNS}
      from public.work_projects p
      join public.deals d
        on d.id = p.deal_id
       and d.org_id = p.org_id
       and d.deleted_at is null
      where p.id = ${projectId}::uuid
        and ${PROJECT_WHERE(auth)}
        and p.deal_id is not null
    `);
    return res.rows[0] ?? null;
  });
}

/** The project linked to a deal, or null when none. */
export async function getProjectLinkedToDeal(
  auth: Authorization,
  dealId: string,
): Promise<ProjectLinkSummary | null> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<ProjectLinkSummary>(sql`
      select
        p.id,
        p.name,
        p.description,
        p.is_archived as "isArchived"
      from public.work_projects p
      join public.deals d
        on d.id = p.deal_id
       and d.org_id = ${auth.ctx.orgId}::uuid
       and d.deleted_at is null
      where p.deal_id = ${dealId}::uuid
        and ${PROJECT_WHERE(auth)}
    `);
    return res.rows[0] ?? null;
  });
}
