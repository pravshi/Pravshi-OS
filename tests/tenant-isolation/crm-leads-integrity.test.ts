import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { CODE, DB_READY, RUN, inContext, mkOrg, sqlstateOf, type Ctx } from '../workflows/helpers';

/**
 * PR-P1-01 (migration 0089) — integrity controls, exercised as app_user through the real
 * driver: the attribution guard, the owner-change guard, actor stamping and binding, per-lead
 * scope on attribution corrections, the two-person rule, stale requests, and row audit.
 *
 * Personas in org A (view and edit scopes are equal for each, so the update-visibility
 * comparison in "edit scope" is exact):
 *   alice  GLOBAL     leads.view/create/edit/assign
 *   carol  SELF       leads.view/create/edit           (department X; reports to frank)
 *   dave   SELF       leads.view/create/edit
 *   erin   DEPARTMENT leads.view/create/edit           (department X; member of team X1 only)
 *   frank  TEAM       leads.view/create/edit           (carol's manager)
 * and bob in org B (GLOBAL, all four).
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const at = (personId: string, orgId: string): Ctx => ({ personId, orgId });
const VIEW_EDIT = ['leads.view', 'leads.create', 'leads.edit'];
// The founder's dedicated attribution permissions (2026-11-06); the SINGLE_MANAGER exception
// permission is granted only where a test needs it.
const ATTRIBUTION = ['leads.attribution.request', 'leads.attribution.approve'];

/** The 0089 functions, by how they must run. */
const INVOKER = [
  'guard_crm_lead_attribution',
  'guard_crm_lead_server_fields',
  'crm_stamp_actor',
  'guard_crm_dedup_candidate_identity',
  'crm_lead_in_scope',
];
const DEFINER = [
  'guard_crm_lead_assignment_history',
  'guard_crm_lead_owner_change',
  'crm_capture_statement_identity',
  'crm_assert_statement_identity',
  'crm_record_lead_assignment',
  'crm_attribution_policy',
  'set_lead_attribution_policy',
  'crm_decide_lead_attribution_correction',
  'apply_lead_attribution_correction',
  'reject_lead_attribution_correction',
];

let orgA = '';
let orgB = '';
let deptX = '';
let teamX1 = '';
let teamX2 = '';
let alice = '';
let bob = '';
let carol = '';
let dave = '';
let erin = '';
let frank = '';
let gina = ''; // DEPARTMENT leads.view/create/edit/assign, department X
let teamOther = ''; // a team of a department gina does not belong to
let leadAlice = '';
let leadCarol = '';
let leadDave = '';
let pondMember = '';
let pondNonMember = '';
let pondNoTeam = '';

async function mkDept(org: string): Promise<string> {
  const code = `LI${RUN.toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;
}

/** An ACTIVE person with a live engagement in `dept` (optionally reporting to `manager`). */
async function mkPersonIn(org: string, dept: string, name: string, manager?: string) {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  const id = (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,'ACTIVE','1990-01-01',$4,'+91-00000-00000') returning id`,
      [org, code, name, `${name.toLowerCase()}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.engagements
       (org_id, person_id, department_id, engagement_type, status, start_date, manager_person_id)
     values ($1,$2,$3,'EMPLOYEE','ACTIVE', current_date, $4)`,
    [org, id, dept, manager ?? null],
  );
  return id;
}

/** A role granting `permissions` at `scope`, assigned to `person`. */
async function grant(org: string, person: string, scope: string, permissions: string[]) {
  const key = `LI_${scope}_${CODE}_${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$2) returning id`,
      [org, key],
    )
  ).rows[0]!.id;
  for (const p of permissions) {
    const { rowCount } = await owner.query(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, id, $3::public.access_scope from public.permissions where key = $2`,
      [role, p, scope],
    );
    if (rowCount !== 1) throw new Error(`permission ${p} missing from the catalogue`);
  }
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
}

/** A lead inserted as the owner (no identity: no stamping, no RLS). */
async function seedLead(
  org: string,
  ownerPerson: string | null,
  team: string | null,
  source = 'manual',
) {
  return (
    await owner.query<{ id: string }>(
      `insert into public.crm_leads (org_id, full_name, primary_phone, source, sla_due_at, owner_person_id, team_id)
       values ($1, 'Lead ' || substr(md5(random()::text), 1, 6), '+919800000001', $2, now() + interval '1 hour', $3, $4)
       returning id`,
      [org, source, ownerPerson, team],
    )
  ).rows[0]!.id;
}

/** Rows a statement affects as `ctx`, inside a transaction that is always rolled back. */
async function affectedThenRollback(ctx: Ctx, sql: string, params: unknown[]): Promise<number> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId,
      ctx.orgId,
    ]);
    return (await c.query(sql, params)).rowCount ?? 0;
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

const requestCorrection = (
  ctx: Ctx,
  lead: string,
  oldValue: string | null,
  newValue: string,
  requester = ctx.personId,
  extra = '',
) =>
  inContext<{ id: string }>(
    asUser,
    ctx,
    `insert into public.crm_lead_attribution_corrections
       (org_id, lead_id, field_name, old_value, new_value, reason, requested_by_person_id${extra ? ', status' : ''})
     values ($1, $2, 'source', $3, $4, 'The source was recorded incorrectly at capture', $5${extra ? `, '${extra}'` : ''})
     returning id`,
    [ctx.orgId, lead, oldValue, newValue, requester],
  );

const approve = (ctx: Ctx, correction: string) =>
  inContext(asUser, ctx, `select public.apply_lead_attribution_correction($1)`, [correction]);

const sourceOf = async (lead: string) =>
  (
    await owner.query<{ source: string }>(`select source from public.crm_leads where id = $1`, [
      lead,
    ])
  ).rows[0]!.source;

describe.skipIf(!DB_READY)('PR-P1-01: 0089 integrity controls (live DB, app_user)', () => {
  beforeAll(async () => {
    orgA = await mkOrg(owner, `leads-int-a-${CODE.toLowerCase()}`);
    orgB = await mkOrg(owner, `leads-int-b-${CODE.toLowerCase()}`);
    deptX = await mkDept(orgA);
    const deptOther = await mkDept(orgA);
    const deptB = await mkDept(orgB);

    alice = await mkPersonIn(orgA, deptOther, 'Alice');
    frank = await mkPersonIn(orgA, deptOther, 'Frank');
    carol = await mkPersonIn(orgA, deptX, 'Carol', frank);
    erin = await mkPersonIn(orgA, deptX, 'Erin');
    dave = await mkPersonIn(orgA, deptOther, 'Dave');
    gina = await mkPersonIn(orgA, deptX, 'Gina');
    bob = await mkPersonIn(orgB, deptB, 'Bob');

    await grant(orgA, alice, 'GLOBAL', [...VIEW_EDIT, 'leads.assign', ...ATTRIBUTION]);
    await grant(orgA, carol, 'SELF', [...VIEW_EDIT, ...ATTRIBUTION]);
    await grant(orgA, dave, 'SELF', [...VIEW_EDIT, ...ATTRIBUTION]);
    await grant(orgA, erin, 'DEPARTMENT', [...VIEW_EDIT, ...ATTRIBUTION]);
    await grant(orgA, frank, 'TEAM', VIEW_EDIT);
    await grant(orgA, gina, 'DEPARTMENT', [...VIEW_EDIT, 'leads.assign']);
    await grant(orgB, bob, 'GLOBAL', [...VIEW_EDIT, 'leads.assign', ...ATTRIBUTION]);

    teamX1 = (
      await owner.query<{ id: string }>(
        `insert into public.teams (org_id, department_id, name) values ($1,$2,'Team X1') returning id`,
        [orgA, deptX],
      )
    ).rows[0]!.id;
    teamX2 = (
      await owner.query<{ id: string }>(
        `insert into public.teams (org_id, department_id, name) values ($1,$2,'Team X2') returning id`,
        [orgA, deptX],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.team_members (org_id, team_id, person_id) values ($1,$2,$3)`,
      [orgA, teamX1, erin],
    );
    teamOther = (
      await owner.query<{ id: string }>(
        `insert into public.teams (org_id, department_id, name) values ($1,$2,'Team Other') returning id`,
        [orgA, deptOther],
      )
    ).rows[0]!.id;

    leadAlice = await seedLead(orgA, alice, null);
    leadCarol = await seedLead(orgA, carol, null);
    leadDave = await seedLead(orgA, dave, null);
    pondMember = await seedLead(orgA, null, teamX1);
    pondNonMember = await seedLead(orgA, null, teamX2);
    pondNoTeam = await seedLead(orgA, null, null);
  });

  afterAll(async () => {
    await asUser.end();
    await owner.end();
  });

  describe('function properties', () => {
    it('runs the attribution guard with invoker rights, the definers as app_owner, and every function with an empty search_path', async () => {
      const { rows } = await owner.query<{
        proname: string;
        prosecdef: boolean;
        owner: string;
        config: string[] | null;
      }>(
        `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1::text[])
         order by p.proname`,
        [[...INVOKER, ...DEFINER]],
      );
      expect(rows.map((r) => r.proname).sort()).toEqual([...INVOKER, ...DEFINER].sort());
      for (const r of rows) {
        // A guard that uses current_user MUST run with invoker rights: inside a SECURITY DEFINER
        // function current_user is the owner (app_owner), so such a guard would never fire.
        expect(r.prosecdef, r.proname).toBe(DEFINER.includes(r.proname));
        if (r.prosecdef) expect(r.owner, r.proname).toBe('app_owner');
        expect(r.config, r.proname).toContain('search_path=""');
      }
    });

    it('lets app_user execute only the request-side helpers and the decision entry points', async () => {
      const { rows } = await owner.query<{ proname: string; can: boolean }>(
        `select p.proname, has_function_privilege('app_user', p.oid, 'execute') as can
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1::text[])`,
        [[...INVOKER, ...DEFINER]],
      );
      const executable = rows
        .filter((r) => r.can)
        .map((r) => r.proname)
        .sort();
      expect(executable).toEqual(
        [
          'apply_lead_attribution_correction',
          'crm_attribution_policy',
          'crm_lead_in_scope',
          'reject_lead_attribution_correction',
          'set_lead_attribution_policy',
        ].sort(),
      );
    });
  });

  describe('crm_leads updates (attribution, owner, recursion)', () => {
    it('lets app_user update a lead at all (the self-referencing WITH CHECK made every UPDATE fail with 42P17)', async () => {
      const n = await affectedThenRollback(
        at(alice, orgA),
        `update public.crm_leads set full_name = 'Renamed' where id = $1`,
        [leadCarol],
      );
      expect(n).toBe(1);
    });

    it('refuses a direct change to source, source_subcategory or campaign_id, even with GLOBAL leads.edit', async () => {
      for (const column of ['source', 'source_subcategory', 'campaign_id']) {
        const value = column === 'source' ? 'website' : 'changed';
        const state = await sqlstateOf(
          inContext(
            asUser,
            at(alice, orgA),
            `update public.crm_leads set ${column} = $2 where id = $1`,
            [leadCarol, value],
          ),
        );
        expect(state, column).toBe('42501');
      }
      expect(await sourceOf(leadCarol)).toBe('manual');
    });

    it('refuses an owner change without leads.assign and allows it with leads.assign', async () => {
      // erin (DEPARTMENT, no leads.assign) takes carol's department-X lead for herself. The new
      // row stays visible to erin, so only the owner-change guard can refuse it (a change that
      // hid the row from the caller would be refused by the SELECT policy whatever the guard did).
      const denied = await sqlstateOf(
        inContext(
          asUser,
          at(erin, orgA),
          `update public.crm_leads set owner_person_id = $2 where id = $1`,
          [leadCarol, erin],
        ),
      );
      expect(denied).toBe('42501');
      const n = await affectedThenRollback(
        at(alice, orgA),
        `update public.crm_leads set owner_person_id = $2 where id = $1`,
        [pondNoTeam, alice],
      );
      expect(n).toBe(1);
    });
  });

  describe('actor identity', () => {
    it('stamps created_by and updated_by from the caller, whatever the statement supplies', async () => {
      const [row] = await inContext<{ id: string; created_by: string; updated_by: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_leads (org_id, full_name, primary_phone, source, sla_due_at, owner_person_id, created_by, updated_by)
         values ($1, 'Stamped', '+919800000002', 'manual', now() + interval '1 hour', $2, $3, $3)
         returning id, created_by, updated_by`,
        [orgA, alice, bob], // bob is a person of ANOTHER organization
      );
      expect(row!.created_by).toBe(alice);
      expect(row!.updated_by).toBe(alice);

      await inContext(
        asUser,
        at(alice, orgA),
        `update public.crm_leads set created_by = $2, full_name = 'Again' where id = $1`,
        [row!.id, carol],
      );
      const after = (
        await owner.query<{ created_by: string; updated_by: string }>(
          `select created_by, updated_by from public.crm_leads where id = $1`,
          [row!.id],
        )
      ).rows[0]!;
      expect(after.created_by).toBe(alice);
      expect(after.updated_by).toBe(alice);
    });

    it('keeps created_by inside the row organization (composite foreign key)', async () => {
      const state = await sqlstateOf(
        owner.query(
          `insert into public.crm_leads (org_id, full_name, primary_phone, source, sla_due_at, created_by)
           values ($1, 'Cross-org author', '+919800000003', 'manual', now() + interval '1 hour', $2)`,
          [orgA, bob],
        ),
      );
      expect(state).toBe('23503');
    });

    it('writes the assignment ledger itself, from the persisted previous owner; app_user cannot write it', async () => {
      // A new lead created with an owner: the database records the initial assignment.
      const [lead] = await inContext<{ id: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_leads (org_id, full_name, primary_phone, source, owner_person_id)
         values ($1, 'Ledger', '+919800000010', 'manual', $2) returning id`,
        [orgA, alice],
      );
      // Two reassignments; the second carries the server's reason through the setting.
      await inContext(
        asUser,
        at(alice, orgA),
        `update public.crm_leads set owner_person_id = $2 where id = $1`,
        [lead!.id, carol],
      );
      const c = await asUser.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                  set_config('app.reassignment_reason','Territory change',true)`,
          [alice, orgA],
        );
        await c.query(`update public.crm_leads set owner_person_id = $2 where id = $1`, [
          lead!.id,
          erin,
        ]);
        await c.query('commit');
      } finally {
        c.release();
      }
      const ledger = (
        await owner.query<{
          from_person_id: string | null;
          to_person_id: string;
          reassigned_by_person_id: string;
          reason: string;
        }>(
          `select from_person_id, to_person_id, reassigned_by_person_id, reason
           from public.crm_lead_assignment_history where lead_id = $1 order by created_at, id`,
          [lead!.id],
        )
      ).rows;
      expect(ledger).toHaveLength(3);
      const byTo = new Map(ledger.map((r) => [r.to_person_id, r]));
      expect(byTo.get(alice)).toMatchObject({
        from_person_id: null,
        reassigned_by_person_id: alice,
        reason: 'Initial assignment',
      });
      expect(byTo.get(carol)).toMatchObject({
        from_person_id: alice,
        reassigned_by_person_id: alice,
        reason: 'Reassignment',
      });
      expect(byTo.get(erin)).toMatchObject({
        from_person_id: carol,
        reassigned_by_person_id: alice,
        reason: 'Territory change',
      });

      // No caller-written entry at all, true or forged.
      const direct = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `insert into public.crm_lead_assignment_history (org_id, lead_id, from_person_id, to_person_id, reassigned_by_person_id, reason)
           values ($1, $2, $3, $4, $4, 'caller-written')`,
          [orgA, lead!.id, dave, erin],
        ),
      );
      expect(direct).toBe('42501');
    });

    it('creates dedup candidates unreviewed and records only the caller as reviewer', async () => {
      const preReviewed = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score, reviewed_by_person_id)
           values ($1, 'lead', $2, $3, 0.9, $4)`,
          [orgA, leadAlice, leadDave, alice],
        ),
      );
      expect(preReviewed).toBe('42501');
      const [cand] = await inContext<{ id: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score)
         values ($1, 'lead', $2, $3, 0.9) returning id`,
        [orgA, leadAlice, leadDave],
      );
      const forged = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `update public.crm_dedup_candidates set status = 'DISMISSED', reviewed_by_person_id = $2, reviewed_at = now() where id = $1`,
          [cand!.id, carol],
        ),
      );
      expect(forged).toBe('42501');
      const ok = await inContext(
        asUser,
        at(alice, orgA),
        `update public.crm_dedup_candidates set status = 'DISMISSED', reviewed_by_person_id = $2, reviewed_at = now() where id = $1 returning id`,
        [cand!.id, alice],
      );
      expect(ok).toHaveLength(1);
    });

    it('refuses a task on a lead the caller cannot see', async () => {
      const state = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
           values ($1, $2, 'Planted', 'FOLLOW_UP', now() + interval '1 day', $3)`,
          [orgA, leadAlice, carol],
        ),
      );
      expect(state).toBe('42501');
      const own = await inContext(
        asUser,
        at(carol, orgA),
        `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
         values ($1, $2, 'Mine', 'FOLLOW_UP', now() + interval '1 day', $3) returning id`,
        [orgA, leadCarol, carol],
      );
      expect(own).toHaveLength(1);
    });
  });

  describe('independent security review, round 2 (F-SEC-1/2/3/4/6/7)', () => {
    let hank = ''; // GLOBAL view/create/edit but only DEPARTMENT leads.assign (department X)

    beforeAll(async () => {
      const deptOfCarol = (
        await owner.query<{ d: string }>(
          `select department_id d from public.engagements where person_id = $1`,
          [carol],
        )
      ).rows[0]!.d;
      hank = await mkPersonIn(orgA, deptOfCarol, 'Hank');
      await grant(orgA, hank, 'GLOBAL', VIEW_EDIT);
      await grant(orgA, hank, 'DEPARTMENT', ['leads.assign']);
      await owner.query(
        `insert into public.team_members (org_id, team_id, person_id) values ($1,$2,$3)`,
        [orgA, teamX2, gina],
      );
    });

    it('F-SEC-4: a new owner must be inside the caller’s leads.assign reach', async () => {
      // hank sees every lead (GLOBAL view), so only the guard can refuse: dave is outside
      // hank's department, erin is inside it.
      const out = await sqlstateOf(
        inContext(
          asUser,
          at(hank, orgA),
          `update public.crm_leads set owner_person_id = $2 where id = $1`,
          [leadCarol, dave],
        ),
      );
      expect(out).toBe('42501');
      const inside = await affectedThenRollback(
        at(hank, orgA),
        `update public.crm_leads set owner_person_id = $2 where id = $1`,
        [leadCarol, erin],
      );
      expect(inside).toBe(1);
    });

    it('F-SEC-4: moving a lead to another team needs leads.assign and a team in the caller’s departments', async () => {
      const noAssign = await sqlstateOf(
        inContext(
          asUser,
          at(erin, orgA),
          `update public.crm_leads set team_id = $2 where id = $1`,
          [leadCarol, teamX1],
        ),
      );
      expect(noAssign).toBe('42501');
      const otherDept = await sqlstateOf(
        inContext(
          asUser,
          at(hank, orgA),
          `update public.crm_leads set team_id = $2 where id = $1`,
          [leadCarol, teamOther],
        ),
      );
      expect(otherDept).toBe('42501');
      const ownDept = await affectedThenRollback(
        at(hank, orgA),
        `update public.crm_leads set team_id = $2 where id = $1`,
        [leadCarol, teamX1],
      );
      expect(ownDept).toBe(1);
    });

    it('F-SEC-2: a dedup candidate is visible and creatable only when both records are', async () => {
      const [cand] = await inContext<{ id: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score)
         values ($1, 'lead', $2, $3, 0.8) returning id`,
        [orgA, leadCarol, leadDave],
      );
      // carol can see her own lead but not dave's.
      const seen = await inContext(
        asUser,
        at(carol, orgA),
        `select id from public.crm_dedup_candidates where id = $1`,
        [cand!.id],
      );
      expect(seen).toHaveLength(0);
      const created = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score)
           values ($1, 'lead', $2, $3, 0.7)`,
          [orgA, leadCarol, leadAlice],
        ),
      );
      expect(created).toBe('42501');
    });

    it('F-SEC-2: a candidate’s pair is immutable and a decided review names the caller', async () => {
      const [cand] = await inContext<{ id: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score)
         values ($1, 'lead', $2, $3, 0.6) returning id`,
        [orgA, pondNoTeam, leadDave],
      );
      const retarget = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `update public.crm_dedup_candidates set duplicate_entity_id = $2 where id = $1`,
          [cand!.id, leadCarol],
        ),
      );
      expect(retarget).toBe('42501');
      const anonymous = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `update public.crm_dedup_candidates set status = 'DISMISSED' where id = $1`,
          [cand!.id],
        ),
      );
      expect(anonymous).toBe('42501');
    });

    it('F-SEC-3: a task cannot be re-pointed to an invisible lead, nor pushed onto an out-of-reach colleague', async () => {
      const [task] = await inContext<{ id: string }>(
        asUser,
        at(carol, orgA),
        `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
         values ($1, $2, 'Re-point me', 'FOLLOW_UP', now() + interval '1 day', $3) returning id`,
        [orgA, leadCarol, carol],
      );
      const repoint = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `update public.crm_lead_tasks set lead_id = $2 where id = $1`,
          [task!.id, leadAlice],
        ),
      );
      expect(repoint).toBe('42501');
      const pushed = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
           values ($1, $2, 'For dave', 'FOLLOW_UP', now() + interval '1 day', $3)`,
          [orgA, leadCarol, dave],
        ),
      );
      expect(pushed).toBe('42501');
      // frank (TEAM) may hand work to carol, who reports to him.
      const delegated = await inContext(
        asUser,
        at(frank, orgA),
        `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
         values ($1, $2, 'For carol', 'FOLLOW_UP', now() + interval '1 day', $3) returning id`,
        [orgA, leadCarol, carol],
      );
      expect(delegated).toHaveLength(1);
    });

    it('F-SEC-6: a DEPARTMENT assigner reaches only the round-robin state of teams in their departments', async () => {
      const otherTeam = await sqlstateOf(
        inContext(
          asUser,
          at(gina, orgA),
          `insert into public.crm_assignment_cursors (org_id, team_id) values ($1, $2)`,
          [orgA, teamOther],
        ),
      );
      expect(otherTeam).toBe('42501');
      const ownTeam = await inContext(
        asUser,
        at(gina, orgA),
        `insert into public.crm_assignment_cursors (org_id, team_id) values ($1, $2) returning id`,
        [orgA, teamX2],
      );
      expect(ownTeam).toHaveLength(1);
      const [global] = await inContext<{ n: number }>(
        asUser,
        at(alice, orgA),
        `select count(*)::int n from public.crm_assignment_cursors where team_id = $1`,
        [teamX2],
      );
      expect(global!.n).toBe(1);
    });

    it('F-SEC-7: stamps the caller even when the identity is spelled as a braced UUID', async () => {
      const [row] = await inContext<{ created_by: string }>(
        asUser,
        { personId: `{${alice}}`, orgId: orgA },
        `insert into public.crm_leads (org_id, full_name, primary_phone, source, sla_due_at, owner_person_id, created_by)
         values ($1, 'Braced', '+919800000005', 'manual', now() + interval '1 hour', $2, $3)
         returning created_by`,
        [orgA, alice, carol],
      );
      expect(row!.created_by).toBe(alice);
    });
  });

  describe('final correction round and founder decisions of 2026-11-06', () => {
    let carolLead2 = '';
    let carolLead3 = '';

    beforeAll(async () => {
      carolLead2 = await seedLead(orgA, carol, null);
      carolLead3 = await seedLead(orgA, carol, null);
    });

    it('SLA ownership: created_at and the SLA fields are set by the server on insert and immutable after', async () => {
      const [row] = await inContext<{
        id: string;
        created_at: Date;
        sla_due_at: Date;
        first_contacted_at: Date | null;
        first_successful_contact_at: Date | null;
        escalated_at: Date | null;
        now: Date;
      }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_leads
           (org_id, full_name, primary_phone, source, owner_person_id, created_at, sla_due_at,
            first_contacted_at, first_successful_contact_at, escalated_at)
         values ($1, 'Clock', '+919800000020', 'manual', $2, '2020-01-01', '2099-01-01',
                 '2020-01-02', '2020-01-03', '2020-01-04')
         returning id, created_at, sla_due_at, first_contacted_at, first_successful_contact_at,
                   escalated_at, now() as now`,
        [orgA, alice],
      );
      expect(row!.created_at.getTime()).toBe(row!.now.getTime());
      expect(row!.sla_due_at.getTime() - row!.created_at.getTime()).toBe(15 * 60 * 1000);
      expect(row!.first_contacted_at).toBeNull();
      expect(row!.first_successful_contact_at).toBeNull();
      expect(row!.escalated_at).toBeNull();
      for (const [column, value] of [
        ['created_at', '2020-01-01'],
        ['sla_due_at', '2099-01-01'],
        ['first_contacted_at', '2026-01-01'],
        ['first_successful_contact_at', '2026-01-01'],
        ['escalated_at', '2026-01-01'],
      ] as const) {
        const state = await sqlstateOf(
          inContext(
            asUser,
            at(alice, orgA),
            `update public.crm_leads set ${column} = $2 where id = $1`,
            [row!.id, value],
          ),
        );
        expect(state, column).toBe('42501');
      }
    });

    it('item 3: lead creation enforces owner and team assignment scope', async () => {
      const create = (ctx: Ctx, ownerPerson: string | null, team: string | null) =>
        inContext(
          asUser,
          ctx,
          `insert into public.crm_leads (org_id, full_name, primary_phone, source, owner_person_id, team_id)
           values ($1, 'Created', '+919800000021', 'manual', $2, $3) returning id`,
          [ctx.orgId, ownerPerson, team],
        );
      // carol (SELF, no leads.assign): may create for herself, in a team of her department.
      expect(await sqlstateOf(create(at(carol, orgA), dave, null)), 'owner = someone else').toBe(
        '42501',
      );
      expect(
        await sqlstateOf(create(at(carol, orgA), carol, teamOther)),
        'team of another department',
      ).toBe('42501');
      expect(await create(at(carol, orgA), carol, teamX1)).toHaveLength(1);
      // gina (DEPARTMENT, leads.assign): may assign within her department only.
      expect(await create(at(gina, orgA), erin, null)).toHaveLength(1);
      expect(await sqlstateOf(create(at(gina, orgA), dave, null)), 'owner outside reach').toBe(
        '42501',
      );
    });

    it('item 2: an identity changed or cleared during a statement aborts it, whatever the triggers do', async () => {
      // carol (SELF, no leads.assign) tries to hand her own lead to dave while switching the
      // identity to alice (GLOBAL leads.assign) inside the statement. Without the pin, RLS USING
      // would have admitted the row as carol and the guard, WITH CHECK and audit would have seen
      // alice.
      const impersonate = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `update public.crm_leads
             set owner_person_id = $2,
                 full_name = full_name || left(set_config('app.person_id', $3, true), 0)
           where id = $1`,
          [carolLead2, dave, alice],
        ),
      );
      expect(impersonate).toBe('42501');
      const cleared = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `update public.crm_leads
             set full_name = full_name || left(set_config('app.person_id', '', true), 0)
           where id = $1`,
          [carolLead2],
        ),
      );
      expect(cleared).toBe('42501');
      const orgSwitch = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `insert into public.crm_leads (org_id, full_name, primary_phone, source, owner_person_id)
           values ($1, 'Switch' || left(set_config('app.org_id', $3, true), 0), '+919800000022', 'manual', $2)`,
          [orgA, alice, orgB],
        ),
      );
      expect(orgSwitch).toBe('42501');
      const owners = await owner.query<{ owner_person_id: string }>(
        `select owner_person_id from public.crm_leads where id = $1`,
        [carolLead2],
      );
      expect(owners.rows[0]!.owner_person_id).toBe(carol);
    });

    it('item 1: an unfiltered bulk update decides only candidates whose two records the caller can see', async () => {
      await inContext(
        asUser,
        at(alice, orgA),
        `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score)
         values ($1, 'lead', $2, $3, 0.5)`,
        [orgA, leadCarol, pondMember],
      );
      const [own] = await inContext<{ id: string }>(
        asUser,
        at(carol, orgA),
        `insert into public.crm_dedup_candidates (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score)
         values ($1, 'lead', $2, $3, 0.5) returning id`,
        [orgA, leadCarol, carolLead2],
      );
      // No WHERE and no RETURNING: the statement reads no column, so Postgres applies only the
      // UPDATE policy's USING clause — exactly the case the both-records rule must cover. (With
      // RETURNING the SELECT policy would apply too and hide a missing USING rule.)
      const c = await asUser.connect();
      let affected = 0;
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
          [carol, orgA],
        );
        affected =
          (
            await c.query(
              `update public.crm_dedup_candidates
                 set status = 'DISMISSED', reviewed_by_person_id = $1, reviewed_at = now()`,
              [carol],
            )
          ).rowCount ?? 0;
        await c.query('commit');
      } catch (error) {
        await c.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
      expect(affected).toBe(1);
      const mine = await owner.query<{ status: string }>(
        `select status from public.crm_dedup_candidates where id = $1`,
        [own!.id],
      );
      expect(mine.rows[0]!.status).toBe('DISMISSED');
      const other = await owner.query<{ status: string }>(
        `select status from public.crm_dedup_candidates where primary_entity_id = $1 and duplicate_entity_id = $2`,
        [leadCarol, pondMember],
      );
      expect(other.rows[0]!.status).toBe('PENDING');
    });

    it('item 5: every activities trigger is present and enabled after 0089', async () => {
      const { rows } = await owner.query<{ tgname: string; tgenabled: string }>(
        `select tgname, tgenabled from pg_trigger
         where tgrelid = 'public.activities'::regclass and not tgisinternal order by tgname`,
      );
      expect(rows).toEqual(
        [
          'activities_audit',
          'activities_enforce_owner_change',
          'activities_link_immutable',
          'activities_set_updated_at',
          'activities_stamp_actor',
        ].map((tgname) => ({ tgname, tgenabled: 'O' })),
      );
    });

    it('dedicated permissions: requesting needs leads.attribution.request, deciding needs leads.attribution.approve', async () => {
      // frank holds leads.view/create/edit (TEAM) but neither attribution permission; carol reports
      // to him, so her lead is inside his scope — only the missing permission can refuse.
      const request = await sqlstateOf(
        requestCorrection(at(frank, orgA), carolLead3, 'manual', 'website'),
      );
      expect(request).toBe('42501');
      const [corr] = await requestCorrection(at(carol, orgA), carolLead3, 'manual', 'website');
      expect(await sqlstateOf(approve(at(frank, orgA), corr!.id))).toBe('42501');
      expect(
        await sqlstateOf(
          inContext(
            asUser,
            at(frank, orgA),
            `select public.reject_lead_attribution_correction($1, $2)`,
            [corr!.id, 'Not a valid change'],
          ),
        ),
      ).toBe('42501');
    });

    it('rejection: needs a reason, records the decision-maker and never modifies the attribution', async () => {
      const [corr] = await requestCorrection(at(carol, orgA), carolLead3, 'manual', 'referral');
      const reject = (ctx: Ctx, reason: string | null) =>
        inContext(asUser, ctx, `select public.reject_lead_attribution_correction($1, $2)`, [
          corr!.id,
          reason,
        ]);
      expect(await sqlstateOf(reject(at(alice, orgA), null)), 'no reason').toBe('23514');
      expect(await sqlstateOf(reject(at(alice, orgA), '   ')), 'blank reason').toBe('23514');
      expect(
        await sqlstateOf(reject(at(carol, orgA), 'My own mistake')),
        'requester under TWO_PERSON',
      ).toBe('42501');
      await reject(at(alice, orgA), 'The original source was right');
      const row = (
        await owner.query<{
          status: string;
          decided_by_person_id: string;
          approved_by_person_id: string | null;
          rejection_reason: string;
          decided_at: Date | null;
        }>(
          `select status, decided_by_person_id, approved_by_person_id, rejection_reason, decided_at
           from public.crm_lead_attribution_corrections where id = $1`,
          [corr!.id],
        )
      ).rows[0]!;
      expect(row).toMatchObject({
        status: 'REJECTED',
        decided_by_person_id: alice,
        approved_by_person_id: null,
        rejection_reason: 'The original source was right',
      });
      expect(row.decided_at).not.toBeNull();
      expect(await sourceOf(carolLead3)).toBe('manual');
      const audit = await owner.query<{ actor_person_id: string }>(
        `select actor_person_id from public.audit_logs
         where entity_id = $1 and action = 'crm_lead.attribution_correction_rejected'`,
        [carolLead3],
      );
      expect(audit.rows.map((r) => r.actor_person_id)).toEqual([alice]);
      expect(await sqlstateOf(approve(at(alice, orgA), corr!.id)), 'decided once').toBe('23514');
    });

    describe('attribution policy (TWO_PERSON default, SINGLE_MANAGER exception)', () => {
      let orgS = '';
      let sam = ''; // settings.manage + request/approve, no exception permission
      let tess = ''; // request/approve + leads.attribution.single_manager, no settings.manage
      let leadS = '';

      beforeAll(async () => {
        orgS = await mkOrg(owner, `leads-int-s-${CODE.toLowerCase()}`);
        const deptS = await mkDept(orgS);
        sam = await mkPersonIn(orgS, deptS, 'Sam');
        tess = await mkPersonIn(orgS, deptS, 'Tess');
        await grant(orgS, sam, 'GLOBAL', [...VIEW_EDIT, ...ATTRIBUTION, 'settings.manage']);
        await grant(orgS, tess, 'GLOBAL', [
          ...VIEW_EDIT,
          ...ATTRIBUTION,
          'leads.attribution.single_manager',
        ]);
        leadS = await seedLead(orgS, tess, null);
      });

      const setPolicy = (ctx: Ctx, policy: string) =>
        inContext(asUser, ctx, `select public.set_lead_attribution_policy($1)`, [policy]);

      it('defaults to TWO_PERSON: even the exception holder cannot decide their own request', async () => {
        const [corr] = await requestCorrection(at(tess, orgS), leadS, 'manual', 'website');
        expect(await sqlstateOf(approve(at(tess, orgS), corr!.id))).toBe('42501');
      });

      it('changes only through settings.manage, only to the two allowed values, and audits the change', async () => {
        expect(
          await sqlstateOf(setPolicy(at(tess, orgS), 'SINGLE_MANAGER')),
          'no settings.manage',
        ).toBe('42501');
        for (const bad of ['OFF', 'DISABLED', 'single_manager', '']) {
          expect(await sqlstateOf(setPolicy(at(sam, orgS), bad)), bad).toBe('22023');
        }
        await setPolicy(at(sam, orgS), 'SINGLE_MANAGER');
        const audit = await owner.query<{
          actor_person_id: string;
          before: unknown;
          after: unknown;
        }>(
          `select actor_person_id, before, after from public.audit_logs
           where entity_id = $1 and action = 'organization.attribution_policy_changed'`,
          [orgS],
        );
        expect(audit.rows).toEqual([
          {
            actor_person_id: sam,
            before: { policy: 'TWO_PERSON' },
            after: { policy: 'SINGLE_MANAGER' },
          },
        ]);
      });

      it('under SINGLE_MANAGER, self-decision needs the exception permission and every use is audited', async () => {
        const [own] = await requestCorrection(at(sam, orgS), leadS, 'manual', 'campaign');
        expect(await sqlstateOf(approve(at(sam, orgS), own!.id)), 'no exception permission').toBe(
          '42501',
        );

        const pending = await owner.query<{ id: string }>(
          `select id from public.crm_lead_attribution_corrections
           where lead_id = $1 and requested_by_person_id = $2 and status = 'PENDING'`,
          [leadS, tess],
        );
        await approve(at(tess, orgS), pending.rows[0]!.id);
        expect(await sourceOf(leadS)).toBe('website');
        const exceptions = await owner.query<{
          actor_person_id: string;
          severity: string;
          metadata: unknown;
        }>(
          `select actor_person_id, severity, metadata from public.audit_logs
           where entity_id = $1 and action = 'crm_lead.attribution_single_manager_exception_used'`,
          [leadS],
        );
        expect(exceptions.rows).toHaveLength(1);
        expect(exceptions.rows[0]).toMatchObject({ actor_person_id: tess, severity: 'CRITICAL' });
        const corrected = await owner.query<{ metadata: Record<string, unknown> }>(
          `select metadata from public.audit_logs
           where entity_id = $1 and action = 'crm_lead.attribution_corrected'`,
          [leadS],
        );
        expect(corrected.rows[0]!.metadata).toMatchObject({
          policy: 'SINGLE_MANAGER',
          single_manager_exception: true,
        });
      });

      it('reads any other stored value as TWO_PERSON: there is no OFF switch', async () => {
        await owner.query(
          `update public.organizations set settings = jsonb_set(coalesce(settings, '{}'), '{attribution}', '{"policy":"OFF"}') where id = $1`,
          [orgS],
        );
        const [corr] = await requestCorrection(at(tess, orgS), leadS, 'website', 'referral');
        expect(await sqlstateOf(approve(at(tess, orgS), corr!.id))).toBe('42501');
      });
    });
  });

  describe('lead scope (crm_lead_in_scope)', () => {
    it('agrees with crm_leads_update for every persona and lead shape', async () => {
      const leads: Array<[string, string, string | null, string | null]> = [
        ['owned by alice', leadAlice, alice, null],
        ['owned by carol', leadCarol, carol, null],
        ['owned by dave', leadDave, dave, null],
        ['pond, team X1 (erin is a member)', pondMember, null, teamX1],
        ['pond, team X2 (erin is not)', pondNonMember, null, teamX2],
        ['pond, no team', pondNoTeam, null, null],
      ];
      const personas: Array<[string, string]> = [
        ['alice GLOBAL', alice],
        ['carol SELF', carol],
        ['dave SELF', dave],
        ['erin DEPARTMENT', erin],
        ['frank TEAM', frank],
      ];
      const disagreements: string[] = [];
      for (const [pname, person] of personas) {
        for (const [lname, lead, ownerPerson, team] of leads) {
          const [helper] = await inContext<{ v: boolean }>(
            asUser,
            at(person, orgA),
            `select public.crm_lead_in_scope('leads.edit', $1::uuid, $2::uuid) as v`,
            [ownerPerson, team],
          );
          const updatable =
            (await affectedThenRollback(
              at(person, orgA),
              `update public.crm_leads set stage = stage where id = $1`,
              [lead],
            )) === 1;
          if (helper!.v !== updatable)
            disagreements.push(`${pname} / ${lname}: helper=${helper!.v} update=${updatable}`);
        }
      }
      expect(disagreements).toEqual([]);
    });

    it('answers from its inputs only; organization isolation comes from the org-filtered row it is given', async () => {
      const [r] = await inContext<{ v: boolean }>(
        asUser,
        at(bob, orgB),
        `select public.crm_lead_in_scope('leads.edit', $1::uuid, null) as v`,
        [carol],
      );
      // bob is GLOBAL in org B: the helper says "in scope", but org B can never reach org A's
      // lead to pass it in — every caller reaches the helper through an org-filtered row.
      expect(r!.v).toBe(true);
      const seen = await inContext(
        asUser,
        at(bob, orgB),
        `select id from public.crm_leads where id = $1`,
        [leadCarol],
      );
      expect(seen).toHaveLength(0);
    });
  });

  describe('attribution corrections', () => {
    let c1 = '';
    let c2 = '';

    it('binds the requester to the caller and starts every request PENDING', async () => {
      const forged = await sqlstateOf(
        requestCorrection(at(alice, orgA), leadCarol, 'manual', 'website', carol),
      );
      expect(forged).toBe('42501');
      const preApproved = await sqlstateOf(
        requestCorrection(at(carol, orgA), leadCarol, 'manual', 'website', carol, 'APPROVED'),
      );
      expect(preApproved).toBe('42501');
    });

    it('refuses a request on a lead outside the caller’s edit scope', async () => {
      const state = await sqlstateOf(
        requestCorrection(at(carol, orgA), leadAlice, 'manual', 'website'),
      );
      expect(state).toBe('42501');
    });

    it('lets the owner request, and keeps a SELF agent from reading corrections on other leads', async () => {
      c1 = (await requestCorrection(at(carol, orgA), leadCarol, 'manual', 'website'))[0]!.id;
      c2 = (await requestCorrection(at(carol, orgA), leadCarol, 'manual', 'referral'))[0]!.id;
      await requestCorrection(at(alice, orgA), leadAlice, 'manual', 'campaign');

      const carolSees = await inContext(
        asUser,
        at(carol, orgA),
        `select id from public.crm_lead_attribution_corrections where lead_id = $1`,
        [leadAlice],
      );
      expect(carolSees).toHaveLength(0);
      const daveSees = await inContext(
        asUser,
        at(dave, orgA),
        `select id from public.crm_lead_attribution_corrections where lead_id = $1`,
        [leadCarol],
      );
      expect(daveSees).toHaveLength(0);
      const aliceSees = await inContext(
        asUser,
        at(alice, orgA),
        `select id from public.crm_lead_attribution_corrections where lead_id = $1 order by requested_at`,
        [leadCarol],
      );
      expect(aliceSees).toHaveLength(2);
    });

    it('refuses self-approval under TWO_PERSON', async () => {
      expect(await sqlstateOf(approve(at(carol, orgA), c1))).toBe('42501');
      expect(await sourceOf(leadCarol)).toBe('manual');
    });

    it('reports a correction outside the approver’s scope, or of another organization, as not found', async () => {
      expect(await sqlstateOf(approve(at(dave, orgA), c1))).toBe('P0002');
      expect(await sqlstateOf(approve(at(bob, orgB), c1))).toBe('P0002');
      expect(await sourceOf(leadCarol)).toBe('manual');
    });

    it('applies an approved correction and records it in the audit log, in the same transaction', async () => {
      await approve(at(alice, orgA), c1);
      expect(await sourceOf(leadCarol)).toBe('website');
      const corr = (
        await owner.query<{ status: string; approved_by_person_id: string }>(
          `select status, approved_by_person_id from public.crm_lead_attribution_corrections where id = $1`,
          [c1],
        )
      ).rows[0]!;
      expect(corr).toEqual({ status: 'APPROVED', approved_by_person_id: alice });

      const audit = await owner.query<{
        action: string;
        actor_person_id: string;
        org_id: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }>(
        `select action, actor_person_id, org_id, before, after, metadata from public.audit_logs
         where entity_id = $1 and action = 'crm_lead.attribution_corrected'`,
        [leadCarol],
      );
      expect(audit.rows).toHaveLength(1);
      const e = audit.rows[0]!;
      expect(e.actor_person_id).toBe(alice);
      expect(e.org_id).toBe(orgA);
      expect(e.before).toEqual({ source: 'manual' });
      expect(e.after).toEqual({ source: 'website' });
      expect(e.metadata).toMatchObject({
        correction_id: c1,
        requested_by_person_id: carol,
        policy: 'TWO_PERSON',
      });
    });

    it('refuses a decided request and a stale one', async () => {
      expect(await sqlstateOf(approve(at(alice, orgA), c1))).toBe('23514');
      // c2 was requested against source = 'manual'; c1 has since made it 'website'.
      expect(await sqlstateOf(approve(at(alice, orgA), c2))).toBe('23514');
      expect(await sourceOf(leadCarol)).toBe('website');
    });

    it('lets a DEPARTMENT approver act on a pond lead of a team they belong to, and not on another team', async () => {
      const member = (await requestCorrection(at(alice, orgA), pondMember, 'manual', 'walk_in'))[0]!
        .id;
      const nonMember = (
        await requestCorrection(at(alice, orgA), pondNonMember, 'manual', 'walk_in')
      )[0]!.id;
      await approve(at(erin, orgA), member);
      expect(await sourceOf(pondMember)).toBe('walk_in');
      // Inside the definer function app_owner sees every team; the helper must still apply
      // app_user's team visibility, or erin would reach team X2's pond.
      expect(await sqlstateOf(approve(at(erin, orgA), nonMember))).toBe('P0002');
      expect(await sourceOf(pondNonMember)).toBe('manual');
    });
  });

  describe('row audit', () => {
    it('records lead, task and correction changes made by a person', async () => {
      const [lead] = await inContext<{ id: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_leads (org_id, full_name, primary_phone, source, sla_due_at, owner_person_id)
         values ($1, 'Audited', '+919800000004', 'manual', now() + interval '1 hour', $2) returning id`,
        [orgA, alice],
      );
      await inContext(
        asUser,
        at(alice, orgA),
        `update public.crm_leads set stage = 'contacted' where id = $1`,
        [lead!.id],
      );
      const [task] = await inContext<{ id: string }>(
        asUser,
        at(alice, orgA),
        `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
         values ($1, $2, 'Call', 'CALL_BACK', now() + interval '1 day', $3) returning id`,
        [orgA, lead!.id, alice],
      );
      const [corr] = await requestCorrection(at(alice, orgA), lead!.id, 'manual', 'website');

      const actions = async (id: string) =>
        (
          await owner.query<{ action: string; actor_person_id: string }>(
            `select action, actor_person_id from public.audit_logs where entity_id = $1 order by occurred_at, action`,
            [id],
          )
        ).rows;
      expect((await actions(lead!.id)).map((r) => r.action)).toEqual([
        'crm_lead.created',
        'crm_lead.updated',
      ]);
      expect((await actions(task!.id)).map((r) => r.action)).toEqual(['crm_lead_task.created']);
      expect((await actions(corr!.id)).map((r) => r.action)).toEqual([
        'crm_lead_attribution_correction.created',
      ]);
      for (const r of await actions(lead!.id)) expect(r.actor_person_id).toBe(alice);
    });
  });
});
