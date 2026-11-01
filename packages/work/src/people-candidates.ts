import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import type { PersonCandidate } from './schema';

/**
 * People picker candidates for Work (project member add, task assignment).
 *
 * THE VISIBILITY CONTRACT — the picker offers exactly the people the write
 * paths would accept, no more and no fewer:
 *
 *  - The query runs as app_user inside withAuthorizedDb, so the
 *    people_select policy (migration 0017) decides the rows: the caller's
 *    own org only, soft-deleted people never, the caller always sees
 *    themself, and everyone else only through the caller's people.view data
 *    scope (GLOBAL → the whole org; DEPARTMENT → people with a live
 *    engagement in the caller's departments; TEAM → reports; PROJECT / SELF
 *    → nobody beyond self), plus the policy's record-grant arm.
 *  - assertPersonVisible (projects.ts) and assertAssigneeVisibleForWrite
 *    (tasks.ts) probe the SAME policy with `select 1 from public.people`, so
 *    a person the picker hides is a person the write would refuse, and a
 *    person the picker shows passes the write probe. One policy, one set —
 *    by construction, not by parallel reimplementation.
 *
 * That is why there is deliberately NO directory definer here, unlike the
 * project roster (0063): the roster must EXCEED people scope under a
 * project-membership gate, so it needs a definer that re-checks a different
 * gate. The picker must NOT exceed people scope, so a definer could only
 * duplicate scope_for / in_my_departments / reports_to_me / record-grant
 * logic and drift from the policy it mirrors.
 *
 * The only narrowing layered on top of the policy is liveness for work:
 * person_status = 'ACTIVE' (the same liveness the 0063 roster directory
 * applies — PROSPECT / INACTIVE / ARCHIVED people are not assignable and
 * are not offered). Narrowing can never widen visibility.
 *
 * The projection is the picker's minimum: id, display name (preferred name
 * winning over legal name, the roster's rule), work email — all inside the
 * column grant migration 0017 leaves app_user on people.
 */
export async function listOrgPeopleCandidates(auth: Authorization): Promise<PersonCandidate[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<PersonCandidate>(sql`
      select per.id as "personId",
             coalesce(per.preferred_name, per.full_legal_name) as "displayName",
             per.work_email as "workEmail"
      from public.people per
      where per.org_id = ${auth.ctx.orgId}::uuid
        and per.deleted_at is null
        and per.person_status = 'ACTIVE'
      order by coalesce(per.preferred_name, per.full_legal_name) asc, per.id asc
    `);
    return res.rows;
  });
}
