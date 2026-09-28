import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Team administration. Teams belong to exactly one department; membership joins
 * people to teams (migration 0004). Mutations go through the narrow SECURITY
 * DEFINER functions in migration 0028 — app_user holds no writes on these
 * tables. Listing is teams.view; every mutation is teams.manage.
 */

export type TeamMember = {
  personId: string;
  name: string;
  workEmail: string | null;
};

export type Team = {
  id: string;
  name: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  leadPersonId: string | null;
  leadName: string | null;
  memberCount: number;
  members: TeamMember[];
};

export async function listTeams(auth: Authorization): Promise<Team[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Team>(sql`
      select
        t.id,
        t.name,
        t.department_id as "departmentId",
        d.code as "departmentCode",
        d.name as "departmentName",
        t.lead_person_id as "leadPersonId",
        lp.full_legal_name as "leadName",
        coalesce(
          (select count(*)::int
           from public.team_members tm
           where tm.team_id = t.id
             and tm.org_id = t.org_id
             and tm.deleted_at is null),
          0
        ) as "memberCount",
        coalesce(
          (select jsonb_agg(
             jsonb_build_object(
               'personId', p.id,
               'name', p.full_legal_name,
               'workEmail', p.work_email
             )
             order by p.full_legal_name
           )
           from public.team_members tm
           join public.people p on p.id = tm.person_id and p.org_id = tm.org_id
           where tm.team_id = t.id
             and tm.org_id = t.org_id
             and tm.deleted_at is null
             and p.deleted_at is null),
          '[]'::jsonb
        ) as members
      from public.teams t
      join public.departments d on d.id = t.department_id and d.org_id = t.org_id
      left join public.people lp on lp.id = t.lead_person_id and lp.org_id = t.org_id
      where t.org_id = ${auth.ctx.orgId}::uuid
        and t.deleted_at is null
      order by d.name, t.name
    `);
    return res.rows;
  });
}

export type PersonOption = {
  id: string;
  name: string;
  workEmail: string | null;
};

/** Live people in the org, for the lead/member pickers. */
export async function listPeopleOptions(auth: Authorization): Promise<PersonOption[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<PersonOption>(sql`
      select p.id, p.full_legal_name as name, p.work_email as "workEmail"
      from public.people p
      where p.org_id = ${auth.ctx.orgId}::uuid
        and p.deleted_at is null
      order by p.full_legal_name
    `);
    return res.rows;
  });
}

export async function createTeam(
  auth: Authorization,
  input: { departmentId: string; name: string; leadPersonId: string | null },
): Promise<string> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Team name is required.');
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      select public.create_team(
        ${input.departmentId}::uuid,
        ${name},
        ${input.leadPersonId}::uuid
      ) as id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Team creation failed.');
    return row.id;
  });
}

export async function updateTeam(
  auth: Authorization,
  id: string,
  input: { name: string; leadPersonId: string | null },
): Promise<void> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Team name is required.');
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      select public.update_team(
        ${id}::uuid,
        ${name},
        ${input.leadPersonId}::uuid
      )
    `);
  });
}

export async function archiveTeam(auth: Authorization, id: string): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`select public.archive_team(${id}::uuid)`);
  });
}

export async function setTeamMembers(
  auth: Authorization,
  teamId: string,
  personIds: string[],
): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      select public.set_team_members(${teamId}::uuid, ${personIds}::uuid[])
    `);
  });
}
