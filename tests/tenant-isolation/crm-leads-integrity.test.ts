import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
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
  'crm_lead_reachable',
  'crm_lead_in_scope',
  'stamp_crm_lead_attribution_request',
];
const DEFINER = [
  'guard_crm_lead_assignment_history',
  'guard_crm_lead_owner_change',
  'crm_capture_statement_identity',
  'crm_assert_statement_identity',
  'crm_record_lead_assignment',
  'crm_assert_recent_mfa',
  'crm_requester_still_authorised',
  'crm_independent_scope',
  'crm_attribution_policy',
  'crm_assert_policy_administrator',
  'crm_apply_attribution_policy',
  'request_attribution_policy_change',
  'approve_attribution_policy_change',
  'reject_attribution_policy_change',
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

const logins = new Map<string, string>();

/** The person's login, enrolled with a verified second factor (created once per person). */
async function mfaLogin(person: string): Promise<string> {
  const known = logins.get(person);
  if (known) return known;
  const login = (
    await owner.query<{ id: string }>(
      `insert into auth.auth_users (name, email, two_factor_enabled)
       values ('MFA', $1, true) returning id`,
      [`mfa.${person}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into auth.auth_two_factors (user_id, secret, backup_codes, verified)
     values ($1, 'fixture-encrypted-seed', 'fixture-encrypted-codes', true)`,
    [login],
  );
  await owner.query(`update public.people set auth_user_id = $2 where id = $1`, [person, login]);
  logins.set(person, login);
  return login;
}

/**
 * A session of the person's login as the authentication plane leaves it (0014): minted
 * `ageSeconds` ago at `aal` — aal2 only when minted by a second-factor verification. Returns the
 * SHA-256 of its bearer token, the step-up evidence the 0089 functions take.
 */
async function session(
  person: string,
  opts: { ageSeconds?: number; aal?: 'aal1' | 'aal2' } = {},
): Promise<string> {
  const login = await mfaLogin(person);
  const token = randomBytes(24).toString('hex');
  await owner.query(
    `insert into auth.auth_sessions (user_id, token, expires_at, created_at, updated_at, aal)
     values ($1, $2, now() + interval '1 hour', now() - make_interval(secs => $3::int),
             now() - make_interval(secs => $3::int), $4)`,
    [login, token, opts.ageSeconds ?? 0, opts.aal ?? 'aal2'],
  );
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** One committed transaction as `ctx`, carrying the session's assurance claim `aal`. */
async function asSession<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
  aal: 'aal1' | 'aal2',
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
              set_config('app.aal',$3,true)`,
      [ctx.personId ?? '', ctx.orgId ?? '', aal],
    );
    const r = await c.query<T>(sql, params);
    await c.query('commit');
    return r.rows;
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** Approval as `ctx` after a fresh step-up (a new aal2 session), unless a session is given. */
const approve = async (ctx: Ctx, correction: string, token?: string) =>
  asSession(ctx, 'aal2', `select public.apply_lead_attribution_correction($1, $2)`, [
    correction,
    token ?? (await session(ctx.personId!)),
  ]);

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
          'crm_lead_reachable',
          'reject_lead_attribution_correction',
          'request_attribution_policy_change',
          'approve_attribution_policy_change',
          'reject_attribution_policy_change',
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

    it('item 2 (review round 3): an identity changed in RETURNING or through a data-modifying CTE aborts too', async () => {
      // RETURNING is evaluated after the BEFORE ROW checks and before the AFTER triggers (audit,
      // assignment ledger): without the AFTER ROW pin the audit entry would name alice.
      const auditBefore = await owner.query<{ n: number }>(
        `select count(*)::int as n from public.audit_logs where entity_id = $1`,
        [carolLead2],
      );
      const returning = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `update public.crm_leads set full_name = 'Returning' where id = $1
           returning left(set_config('app.person_id', $2, true), 0) as x`,
          [carolLead2, alice],
        ),
      );
      expect(returning).toBe('42501');
      const auditAfter = await owner.query<{ n: number }>(
        `select count(*)::int as n from public.audit_logs where entity_id = $1`,
        [carolLead2],
      );
      expect(auditAfter.rows[0]!.n).toBe(auditBefore.rows[0]!.n);

      // A data-modifying CTE on another pinned table fires its own statement capture when it is
      // first read — here after the main statement's WHERE switched the identity to alice. It
      // must not be able to re-capture the changed identity for the transaction.
      const [task] = await inContext<{ id: string }>(
        asUser,
        at(carol, orgA),
        `insert into public.crm_lead_tasks (org_id, lead_id, title, task_type, due_at, assignee_person_id)
         values ($1, $2, 'CTE', 'FOLLOW_UP', now() + interval '1 day', $3) returning id`,
        [orgA, carolLead2, carol],
      );
      const cte = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `with t as (update public.crm_lead_tasks set title = 'CTE touched' where id = $3 returning id)
           update public.crm_leads set owner_person_id = $2
           where id = $1
             -- CASE fixes the order: the identity is switched BEFORE the CTE is first read.
             and case when set_config('app.person_id', $4, true) is not null
                      then exists (select 1 from t) else false end`,
          [carolLead2, dave, task!.id, alice],
        ),
      );
      expect(cte).toBe('42501');
      const owners = await owner.query<{ owner_person_id: string; full_name: string }>(
        `select owner_person_id, full_name from public.crm_leads where id = $1`,
        [carolLead2],
      );
      expect(owners.rows[0]!.owner_person_id).toBe(carol);
      expect(owners.rows[0]!.full_name).not.toBe('Returning');
    });

    it('F-SEC-14: updated_at is stamped by the server on every update', async () => {
      const [row] = await inContext<{ updated_at: Date; now: Date }>(
        asUser,
        at(carol, orgA),
        `update public.crm_leads set full_name = full_name, updated_at = '2020-01-01' where id = $1
         returning updated_at, now() as now`,
        [carolLead3],
      );
      expect(row!.updated_at.getTime()).toBe(row!.now.getTime());
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

    describe('attribution governance (founder decisions F-SEC-12/13 and F-SEC-19..23)', () => {
      let orgS = '';
      let deptS = '';
      let superRole = '';
      // Policy administrators (settings.manage_attribution_policy), each MFA-enrolled:
      let adminTwo = ''; //  SUPER_ADMIN, genesis grant (nobody granted it)
      let adminOne = ''; //  SUPER_ADMIN, granted by adminTwo — the usual requester
      let crony = ''; //     SUPER_ADMIN granted BY adminOne before the request (audited grant)
      let delegate = ''; //  custom role whose policy permission adminOne granted (audited)
      let delegate2 = ''; // custom role assigned with granted_by = adminOne (no audit entry)
      let lateAdmin = ''; // SUPER_ADMIN granted by adminTwo only AFTER the request
      let opsAdmin = ''; //  seeded ADMIN (settings.manage, not the policy permission)
      let deptAdmin = ''; // the policy permission at DEPARTMENT scope only
      let upgraded = ''; //  held it at DEPARTMENT before the request; upgraded to GLOBAL after it
      let upgradedRole = '';
      // Attribution personas:
      let tess = ''; //  request/approve + leads.attribution.single_manager (granted deliberately)
      let sam = ''; //   request/approve, no exception
      let rita = ''; //  request only (GLOBAL), the correction requester
      let sela = ''; //  request only at SELF scope
      let vic = ''; //   approve only (GLOBAL), granted before any request
      let lateVic = ''; // approve granted only AFTER a request
      let ritaRole = '';
      let leadS = '';
      let pendingTess = '';

      const lead = (ownerPerson: string) => seedLead(orgS, ownerPerson, null);
      const tokenFor = (person: string, ageSeconds = 0) => session(person, { ageSeconds });

      /** A custom role holding `permissions` at `scope`, created with `actor` as the audited author. */
      async function roleWith(permissions: string[], scope: string, actor?: string) {
        const c = await owner.connect();
        try {
          await c.query('begin');
          if (actor) {
            await c.query(
              `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
              [actor, orgS],
            );
          }
          const key = `GOV_${CODE}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
          const role = (
            await c.query<{ id: string }>(
              `insert into public.roles (org_id, key, name) values ($1,$2,$2) returning id`,
              [orgS, key],
            )
          ).rows[0]!.id;
          for (const p of permissions) {
            await c.query(
              `insert into public.role_permissions (role_id, permission_id, scope)
               select $1, id, $3::public.access_scope from public.permissions where key = $2`,
              [role, p, scope],
            );
          }
          await c.query('commit');
          return role;
        } catch (error) {
          await c.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          c.release();
        }
      }

      /**
       * Assigns a role. `actor` (an existing roles.manage holder) is the audited author; without
       * one a protected role takes the genesis branch. `grantedBy` sets person_roles.granted_by.
       */
      async function assign(
        person: string,
        role: string,
        opts: { actor?: string; grantedBy?: string } = {},
      ) {
        const c = await owner.connect();
        try {
          await c.query('begin');
          if (opts.actor) {
            await c.query(
              `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
              [opts.actor, orgS],
            );
          }
          await c.query(
            `insert into public.person_roles (person_id, role_id, org_id, granted_by)
             values ($1, $2, $3, $4)`,
            [person, role, orgS, opts.grantedBy ?? null],
          );
          await c.query('commit');
        } catch (error) {
          await c.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          c.release();
        }
      }

      const as = (person: string) => at(person, orgS);
      /** One owner statement with `actor` as the identified person (guards that need an actor). */
      async function byActor(actor: string, sql: string, params: unknown[]) {
        const c = await owner.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
            [actor, orgS],
          );
          await c.query(sql, params);
          await c.query('commit');
        } catch (error) {
          await c.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          c.release();
        }
      }
      const requestPolicy = async (
        person: string,
        policy: string,
        reason: string,
        token?: string,
      ) =>
        (
          await asSession<{ id: string }>(
            as(person),
            'aal2',
            `select public.request_attribution_policy_change($1, $2, $3) as id`,
            [policy, reason, token === undefined ? await tokenFor(person) : token],
          )
        )[0]!.id;
      const approvePolicy = async (person: string, change: string, token?: string) =>
        asSession(as(person), 'aal2', `select public.approve_attribution_policy_change($1, $2)`, [
          change,
          token === undefined ? await tokenFor(person) : token,
        ]);
      const rejectPolicy = async (person: string, change: string, reason: string) =>
        asSession(
          as(person),
          'aal2',
          `select public.reject_attribution_policy_change($1, $2, $3)`,
          [change, reason, await tokenFor(person)],
        );
      const decide = async (person: string, correction: string, token?: string | null) =>
        asSession(as(person), 'aal2', `select public.apply_lead_attribution_correction($1, $2)`, [
          correction,
          token === undefined ? await tokenFor(person) : token,
        ]);
      const rejectOwn = async (person: string, correction: string, token: string | null) =>
        asSession(
          as(person),
          'aal2',
          `select public.reject_lead_attribution_correction($1, $2, $3)`,
          [correction, 'Withdrawn by the requester', token],
        );
      const policyOf = async () =>
        (
          await owner.query<{ p: string | null }>(
            `select settings->'attribution'->>'policy' as p from public.organizations where id = $1`,
            [orgS],
          )
        ).rows[0]!.p;
      const setPolicyDirectly = (value: string | null) =>
        owner.query(
          value === null
            ? `update public.organizations set settings = settings - 'attribution' where id = $1`
            : `update public.organizations
                 set settings = jsonb_set(coalesce(settings, '{}'), '{attribution}',
                                          jsonb_build_object('policy', $2::text))
               where id = $1`,
          value === null ? [orgS] : [orgS, value],
        );
      const changeRow = async (change: string) =>
        (
          await owner.query<{ status: string; decision_reason: string | null }>(
            `select status, decision_reason from public.crm_attribution_policy_changes where id = $1`,
            [change],
          )
        ).rows[0]!;
      const ageRequest = (table: string, id: string, days: number) =>
        owner.query(
          `update public.${table} set requested_at = now() - make_interval(days => $2) where id = $1`,
          [id, days],
        );

      beforeAll(async () => {
        orgS = await mkOrg(owner, `leads-int-s-${CODE.toLowerCase()}`);
        deptS = await mkDept(orgS);
        superRole = (
          await owner.query<{ id: string }>(
            `select id from public.roles where org_id = $1 and key = 'SUPER_ADMIN'`,
            [orgS],
          )
        ).rows[0]!.id;
        const names: Record<string, string> = {};
        for (const n of [
          'AdminTwo',
          'AdminOne',
          'Crony',
          'Delegate',
          'DelegateTwo',
          'LateAdmin',
          'OpsAdmin',
          'DeptAdmin',
          'Tess',
          'Sam',
          'Rita',
          'Sela',
          'Vic',
          'LateVic',
          'Upgraded',
        ]) {
          names[n] = await mkPersonIn(orgS, deptS, n);
          await mfaLogin(names[n]!);
        }
        const n = (key: string) => names[key]!;
        adminTwo = n('AdminTwo');
        adminOne = n('AdminOne');
        crony = n('Crony');
        delegate = n('Delegate');
        delegate2 = n('DelegateTwo');
        lateAdmin = n('LateAdmin');
        opsAdmin = n('OpsAdmin');
        deptAdmin = n('DeptAdmin');
        tess = n('Tess');
        sam = n('Sam');
        rita = n('Rita');
        sela = n('Sela');
        vic = n('Vic');
        lateVic = n('LateVic');
        upgraded = n('Upgraded');

        await assign(adminTwo, superRole); // genesis
        await assign(adminOne, superRole, { actor: adminTwo });
        await assign(crony, superRole, { actor: adminOne }); // audited grant by the requester
        await assign(
          delegate,
          await roleWith(['settings.manage_attribution_policy'], 'GLOBAL', adminOne),
          {
            actor: adminTwo,
          },
        );
        await assign(delegate2, await roleWith(['settings.manage_attribution_policy'], 'GLOBAL'), {
          grantedBy: adminOne,
        });
        upgradedRole = await roleWith(['settings.manage_attribution_policy'], 'DEPARTMENT');
        await assign(upgraded, upgradedRole);
        const adminRole = (
          await owner.query<{ id: string }>(
            `select id from public.roles where org_id = $1 and key = 'ADMIN'`,
            [orgS],
          )
        ).rows[0]!.id;
        await assign(opsAdmin, adminRole);
        await assign(
          deptAdmin,
          await roleWith(['settings.manage_attribution_policy'], 'DEPARTMENT'),
        );
        await grant(orgS, tess, 'GLOBAL', [
          ...VIEW_EDIT,
          ...ATTRIBUTION,
          'leads.attribution.single_manager',
        ]);
        await grant(orgS, sam, 'GLOBAL', [...VIEW_EDIT, ...ATTRIBUTION]);
        ritaRole = await roleWith([...VIEW_EDIT, 'leads.attribution.request'], 'GLOBAL');
        await assign(rita, ritaRole);
        await grant(orgS, sela, 'SELF', [...VIEW_EDIT, 'leads.attribution.request']);
        await grant(orgS, vic, 'GLOBAL', [...VIEW_EDIT, 'leads.attribution.approve']);
        await grant(orgS, lateVic, 'GLOBAL', VIEW_EDIT);
        leadS = await lead(tess);
      });

      it('seeds settings.manage_attribution_policy to SUPER_ADMIN only, and the exception to no role', async () => {
        const { rows } = await owner.query<{ role: string; key: string }>(
          `select r.key as role, p.key from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           join public.permissions p on p.id = rp.permission_id
           where r.org_id = $1 and r.is_system
             and p.key in ('settings.manage_attribution_policy', 'leads.attribution.single_manager')
           order by 1, 2`,
          [orgS],
        );
        expect(rows).toEqual([{ role: 'SUPER_ADMIN', key: 'settings.manage_attribution_policy' }]);
      });

      it('stamps a correction request with the database time, whatever the caller supplies', async () => {
        const target = await lead(rita);
        const [row] = await inContext<{ requested_at: Date }>(
          asUser,
          as(rita),
          `insert into public.crm_lead_attribution_corrections
             (org_id, lead_id, field_name, old_value, new_value, reason, requested_by_person_id, requested_at)
           values ($1, $2, 'source', 'manual', 'website', 'Backdated to dodge the expiry window', $3,
                   now() + interval '30 days')
           returning requested_at`,
          [orgS, target, rita],
        );
        expect(Math.abs(row!.requested_at.getTime() - Date.now())).toBeLessThan(60_000);
      });

      it('TWO_PERSON is the default: even the exception holder, freshly stepped up, cannot decide their own request', async () => {
        expect(await policyOf()).toBeNull();
        const [corr] = await requestCorrection(as(tess), leadS, 'manual', 'website');
        pendingTess = corr!.id;
        expect(await sqlstateOf(decide(tess, pendingTess))).toBe('42501');
      });

      it('only a GLOBAL holder of settings.manage_attribution_policy administers the policy: not ADMIN, not a department-scoped holder', async () => {
        const reason = 'Small team, single approver';
        expect(await sqlstateOf(requestPolicy(opsAdmin, 'SINGLE_MANAGER', reason)), 'ADMIN').toBe(
          '42501',
        );
        expect(
          await sqlstateOf(requestPolicy(deptAdmin, 'SINGLE_MANAGER', reason)),
          'DEPARTMENT scope',
        ).toBe('42501');
      });

      it("requires step-up MFA within the last 5 minutes, proven by the caller's own live aal2 session", async () => {
        const reason = 'Small team, single approver';
        const refuse = async (label: string, token: string | null, aal: 'aal1' | 'aal2' = 'aal2') =>
          expect(
            await sqlstateOf(
              asSession(
                as(adminOne),
                aal,
                `select public.request_attribution_policy_change($1, $2, $3)`,
                ['SINGLE_MANAGER', reason, token],
              ),
            ),
            label,
          ).toBe('42501');
        await refuse('no session proof', null);
        await refuse('malformed proof', 'abc');
        await refuse('stepped up 6 minutes ago', await tokenFor(adminOne, 360));
        await refuse('MFA only at sign-in, 3 hours ago', await tokenFor(adminOne, 3 * 3600));
        await refuse('fresh password-only session', await session(adminOne, { aal: 'aal1' }));
        // adminOne holds a fresh, valid step-up session of their own, but presents adminTwo's:
        // only the binding of the proof to the caller's own session can refuse this.
        await tokenFor(adminOne);
        await refuse("another administrator's fresh session", await tokenFor(adminTwo));
        await refuse(
          'fresh aal2 session, transaction claims aal1',
          await tokenFor(adminOne),
          'aal1',
        );
        await owner.query(`update auth.auth_two_factors set verified = false where user_id = $1`, [
          logins.get(adminOne),
        ]);
        await refuse('second factor no longer verified', await tokenFor(adminOne));
        await owner.query(`update auth.auth_two_factors set verified = true where user_id = $1`, [
          logins.get(adminOne),
        ]);
        const beforeRevocation = await tokenFor(adminOne, 60);
        await owner.query(`update public.people set sessions_revoked_at = now() where id = $1`, [
          adminOne,
        ]);
        await refuse('session older than a revocation', beforeRevocation);
        await owner.query(`update public.people set sessions_revoked_at = null where id = $1`, [
          adminOne,
        ]);

        // Within the window (4 minutes) the same request succeeds; it is then withdrawn.
        const ok = await requestPolicy(
          adminOne,
          'SINGLE_MANAGER',
          reason,
          await tokenFor(adminOne, 240),
        );
        expect((await changeRow(ok)).status).toBe('PENDING');
        await rejectPolicy(adminTwo, ok, 'Withdrawn after the test');
        expect((await changeRow(ok)).status).toBe('REJECTED');
      });

      it('allows only TWO_PERSON or SINGLE_MANAGER, with a reason', async () => {
        for (const bad of ['OFF', 'DISABLED', 'single_manager', '']) {
          expect(
            await sqlstateOf(requestPolicy(adminOne, bad, 'Trying an invalid value')),
            bad,
          ).toBe('22023');
        }
        expect(await sqlstateOf(requestPolicy(adminOne, 'SINGLE_MANAGER', 'short')), 'reason').toBe(
          '22023',
        );
      });

      it('enabling SINGLE_MANAGER needs an independent second administrator, freshly stepped up', async () => {
        const change = await requestPolicy(
          adminOne,
          'SINGLE_MANAGER',
          'Two-person team: one approver available',
        );
        expect(await policyOf()).toBeNull(); // pending, not applied

        // Authority granted by the requester AFTER the request, through the real path.
        const lateCrony = await mkPersonIn(orgS, deptS, 'LateCrony');
        await mfaLogin(lateCrony);
        await asSession(as(adminOne), 'aal2', `select public.set_person_roles($1, $2::uuid[])`, [
          lateCrony,
          [superRole],
        ]);
        await assign(lateAdmin, superRole, { actor: adminTwo }); // by someone else, after the request

        const refused = async (label: string, person: string, token?: string) =>
          expect(await sqlstateOf(approvePolicy(person, change, token)), label).toBe('42501');
        await refused('the requester', adminOne);
        await refused('granted SUPER_ADMIN by the requester after the request', lateCrony);
        await refused('granted SUPER_ADMIN by the requester before it (audit log)', crony);
        await refused("the role's permission granted by the requester (audit log)", delegate);
        await refused('assignment recorded as granted by the requester', delegate2);
        await refused('granted by another administrator only after the request', lateAdmin);
        await refused('ADMIN', opsAdmin);
        await refused('department-scoped holder', deptAdmin);
        // The grant's scope is raised to GLOBAL after the request, by someone else: a later scope
        // change counts as a new grant (role_permissions.updated_at), so it is not independent.
        const c = await owner.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
            [adminTwo, orgS],
          );
          await c.query(
            `update public.role_permissions set scope = 'GLOBAL'
             where role_id = $1
               and permission_id = (select id from public.permissions
                                    where key = 'settings.manage_attribution_policy')`,
            [upgradedRole],
          );
          await c.query('commit');
        } finally {
          c.release();
        }
        await refused('scope raised to GLOBAL only after the request', upgraded);
        await refused(
          'independent, but stepped up 6 minutes ago',
          adminTwo,
          await tokenFor(adminTwo, 360),
        );
        expect(await policyOf()).toBeNull();

        await approvePolicy(adminTwo, change);
        expect(await policyOf()).toBe('SINGLE_MANAGER');

        const audit = await owner.query<{
          actor_person_id: string;
          org_id: string;
          severity: string;
          before: unknown;
          after: unknown;
          metadata: Record<string, unknown>;
          occurred_at: Date;
        }>(
          `select actor_person_id, org_id, severity, before, after, metadata, occurred_at
           from public.audit_logs
           where entity_id = $1 and action = 'organization.attribution_policy_activated'`,
          [orgS],
        );
        expect(audit.rows).toHaveLength(1);
        const e = audit.rows[0]!;
        expect(e).toMatchObject({
          actor_person_id: adminTwo,
          org_id: orgS,
          severity: 'CRITICAL',
          before: { policy: 'TWO_PERSON' },
          after: { policy: 'SINGLE_MANAGER' },
        });
        expect(e.metadata).toMatchObject({
          change_id: change,
          reason: 'Two-person team: one approver available',
          requested_by_person_id: adminOne,
          approved_by_person_id: adminTwo,
          aal: 'aal2',
          step_up_mfa: true,
        });
        expect(e.metadata.requested_at).toBeTruthy();
        expect(e.occurred_at).toBeInstanceOf(Date);
        expect(
          await owner
            .query(
              `select status, requested_by_person_id, decided_by_person_id
             from public.crm_attribution_policy_changes where id = $1`,
              [change],
            )
            .then((r) => r.rows[0]),
        ).toEqual({
          status: 'APPLIED',
          requested_by_person_id: adminOne,
          decided_by_person_id: adminTwo,
        });
      });

      it('under SINGLE_MANAGER only an authorised exception holder, freshly stepped up, decides their own request; each use is CRITICAL-audited', async () => {
        const [own] = await requestCorrection(as(sam), leadS, 'manual', 'campaign');
        expect(await sqlstateOf(decide(sam, own!.id)), 'no exception permission').toBe('42501');
        expect(await sqlstateOf(decide(tess, pendingTess, null)), 'no step-up').toBe('42501');
        expect(
          await sqlstateOf(decide(tess, pendingTess, await tokenFor(tess, 360))),
          'stale step-up',
        ).toBe('42501');
        await decide(tess, pendingTess);
        expect(await sourceOf(leadS)).toBe('website');

        // Withdrawing one's own request is also a use of the exception: step-up MFA, audited.
        const [withdraw] = await requestCorrection(as(tess), leadS, 'website', 'referral');
        expect(await sqlstateOf(rejectOwn(tess, withdraw!.id, null)), 'withdraw, no step-up').toBe(
          '42501',
        );
        await rejectOwn(tess, withdraw!.id, await tokenFor(tess));
        expect(await sourceOf(leadS)).toBe('website');

        const used = await owner.query<{
          actor_person_id: string;
          severity: string;
          metadata: Record<string, unknown>;
        }>(
          `select actor_person_id, severity, metadata from public.audit_logs
           where entity_id = $1 and action = 'crm_lead.attribution_single_manager_exception_used'
           order by occurred_at`,
          [leadS],
        );
        expect(used.rows.map((r) => [r.actor_person_id, r.severity, r.metadata.decision])).toEqual([
          [tess, 'CRITICAL', 'APPROVED'],
          [tess, 'CRITICAL', 'REJECTED'],
        ]);
        expect(used.rows[0]!.metadata).toMatchObject({
          policy: 'SINGLE_MANAGER',
          aal: 'aal2',
          step_up_mfa: true,
        });
      });

      it('serialises a policy switch with an exception decision: the decision waits, then sees TWO_PERSON and is refused', async () => {
        expect(await policyOf()).toBe('SINGLE_MANAGER');
        const raceLead = await lead(tess);
        const [corr] = await requestCorrection(as(tess), raceLead, 'manual', 'website');
        const tokA = await tokenFor(adminOne);
        const tokB = await tokenFor(tess);
        const a = await asUser.connect();
        const b = await asUser.connect();
        try {
          const bPid = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
            .pid;
          await a.query('begin');
          await a.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                    set_config('app.aal','aal2',true)`,
            [adminOne, orgS],
          );
          await a.query(`select public.request_attribution_policy_change('TWO_PERSON', $1, $2)`, [
            'Switching back while a decision is in flight',
            tokA,
          ]);
          await b.query('begin');
          await b.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                    set_config('app.aal','aal2',true)`,
            [tess, orgS],
          );
          const decision = b
            .query(`select public.apply_lead_attribution_correction($1, $2)`, [corr!.id, tokB])
            .then(
              () => 'NO ERROR',
              (error: { code?: string }) => error.code ?? String(error),
            );
          let waiting = false;
          for (let i = 0; i < 100 && !waiting; i++) {
            const { rows } = await owner.query<{ n: number }>(
              `select count(*)::int as n from pg_locks where pid = $1 and not granted`,
              [bPid],
            );
            waiting = rows[0]!.n > 0;
            if (!waiting) await new Promise((r) => setTimeout(r, 100));
          }
          expect(waiting, 'the decision waits for the policy switch').toBe(true);
          // The policy step's FOR NO KEY UPDATE must not block the tenant's ordinary inserts (their
          // foreign-key check takes FOR KEY SHARE on the organization row).
          const other = await owner.connect();
          try {
            await other.query('begin');
            await other.query(`set local lock_timeout = '3s'`);
            await other.query(
              `insert into public.crm_leads (org_id, full_name, primary_phone, source, sla_due_at)
               values ($1, 'Inserted during a policy step', '+919800000002', 'manual', now() + interval '1 hour')`,
              [orgS],
            );
            await other.query('rollback');
          } finally {
            other.release();
          }
          await a.query('commit');
          expect(await decision, 'decided against the committed TWO_PERSON policy').toBe('42501');
          await b.query('rollback');
        } finally {
          await a.query('rollback').catch(() => undefined);
          a.release();
          b.release();
        }
        expect(await policyOf()).toBe('TWO_PERSON');
        expect(await sourceOf(raceLead)).toBe('manual');
        const deactivated = await owner.query<{
          actor_person_id: string;
          severity: string;
          after: unknown;
        }>(
          `select actor_person_id, severity, after from public.audit_logs
           where entity_id = $1 and action = 'organization.attribution_policy_deactivated'`,
          [orgS],
        );
        expect(deactivated.rows).toEqual([
          { actor_person_id: adminOne, severity: 'CRITICAL', after: { policy: 'TWO_PERSON' } },
        ]);
      });

      it('reads any other stored value as TWO_PERSON: there is no OFF switch', async () => {
        await setPolicyDirectly('OFF');
        const [corr] = await requestCorrection(as(tess), leadS, 'website', 'walk_in');
        expect(await sqlstateOf(decide(tess, corr!.id))).toBe('42501');
        await setPolicyDirectly(null);
      });

      it('approving a policy change re-checks the requester, the expiry and the current policy', async () => {
        // The requester was demoted after asking.
        const demoted = await requestPolicy(
          adminOne,
          'SINGLE_MANAGER',
          'Requested before demotion',
        );
        const c = await owner.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
            [adminTwo, orgS],
          );
          await c.query(`delete from public.person_roles where person_id = $1 and role_id = $2`, [
            adminOne,
            superRole,
          ]);
          await c.query('commit');
        } finally {
          c.release();
        }
        expect(await sqlstateOf(approvePolicy(adminTwo, demoted)), 'requester demoted').toBe(
          '23514',
        );
        await assign(adminOne, superRole, { actor: adminTwo });
        await rejectPolicy(adminTwo, demoted, 'Requester was demoted');

        // An expired request can never be approved; the next request closes it.
        const expired = await requestPolicy(
          adminOne,
          'SINGLE_MANAGER',
          'Will expire before approval',
        );
        await ageRequest('crm_attribution_policy_changes', expired, 8);
        expect(await sqlstateOf(approvePolicy(adminTwo, expired)), 'expired').toBe('23514');
        const next = await requestPolicy(adminOne, 'SINGLE_MANAGER', 'Asking again after expiry');
        expect(await changeRow(expired)).toEqual({
          status: 'REJECTED',
          decision_reason: 'Expired: not approved within 7 days',
        });
        const expiredAudit = await owner.query(
          `select 1 from public.audit_logs where entity_id = $1
             and action = 'organization.attribution_policy_change_expired'
             and metadata ->> 'change_id' = $2`,
          [orgS, expired],
        );
        expect(expiredAudit.rowCount).toBe(1);

        // One pending change at a time; rejection rules.
        expect(
          await sqlstateOf(requestPolicy(adminOne, 'SINGLE_MANAGER', 'A second pending request')),
          'second pending',
        ).toBe('23505');
        expect(await sqlstateOf(rejectPolicy(adminTwo, next, 'no')), 'short reason').toBe('22023');
        expect(
          await sqlstateOf(
            rejectPolicy(adminTwo, '00000000-0000-4000-8000-000000000000', 'Not ours'),
          ),
          'unknown change',
        ).toBe('P0002');
        await rejectPolicy(adminTwo, next, 'Not now, revisit next quarter');
        expect(await sqlstateOf(rejectPolicy(adminTwo, next, 'Again please')), 'decided').toBe(
          '23514',
        );

        // The policy changed underneath the request.
        const stale = await requestPolicy(adminOne, 'SINGLE_MANAGER', 'Made against TWO_PERSON');
        await setPolicyDirectly('SINGLE_MANAGER');
        expect(await sqlstateOf(approvePolicy(adminTwo, stale)), 'stale').toBe('23514');
        await setPolicyDirectly(null);
        await rejectPolicy(adminTwo, stale, 'Superseded');
      });

      it('approving a correction needs a fresh step-up and an independent approver who held authority before the request', async () => {
        const target = await lead(rita);
        const [corr] = await requestCorrection(as(rita), target, 'manual', 'website');
        await grant(orgS, lateVic, 'GLOBAL', ['leads.attribution.approve']); // after the request
        expect(await sqlstateOf(decide(vic, corr!.id, null)), 'no step-up').toBe('42501');
        expect(
          await sqlstateOf(decide(vic, corr!.id, await tokenFor(vic, 360))),
          'stale step-up',
        ).toBe('42501');
        expect(
          await sqlstateOf(decide(lateVic, corr!.id)),
          'approval authority granted after the request',
        ).toBe('42501');
        expect(await sourceOf(target)).toBe('manual');
        await decide(vic, corr!.id);
        expect(await sourceOf(target)).toBe('website');
      });

      it('approving a correction re-checks the requester: still active, still authorised, the lead still in scope', async () => {
        const refusedFor = async (
          label: string,
          requester: string,
          change: (target: string) => Promise<unknown>,
          undo: () => Promise<unknown>,
        ) => {
          const target = await lead(requester);
          const [corr] = await requestCorrection(as(requester), target, 'manual', 'website');
          await change(target);
          try {
            expect(await sqlstateOf(decide(vic, corr!.id)), label).toBe('23514');
            expect(await sourceOf(target), label).toBe('manual');
          } finally {
            await undo();
          }
        };
        // A requester suspended after asking (a dedicated persona: SUSPENDED -> ACTIVE is not a
        // permitted engagement transition, so nobody else's state is touched).
        const suspended = await mkPersonIn(orgS, deptS, 'Rhea');
        await grant(orgS, suspended, 'GLOBAL', [...VIEW_EDIT, 'leads.attribution.request']);
        await refusedFor(
          'requester suspended',
          suspended,
          () =>
            byActor(
              adminTwo,
              `update public.engagements set status = 'SUSPENDED' where person_id = $1`,
              [suspended],
            ),
          async () => undefined,
        );
        await refusedFor(
          'requester lost leads.attribution.request',
          rita,
          () =>
            owner.query(`delete from public.person_roles where person_id = $1 and role_id = $2`, [
              rita,
              ritaRole,
            ]),
          () => assign(rita, ritaRole),
        );
        // A SELF-scoped requester: the lead is handed to someone else after the request.
        await refusedFor(
          "the lead left the requester's scope",
          sela,
          (target) =>
            owner.query(`update public.crm_leads set owner_person_id = $2 where id = $1`, [
              target,
              tess,
            ]),
          async () => undefined,
        );
      });

      it('an expired correction request can never change attribution, but can still be rejected', async () => {
        const target = await lead(rita);
        const [corr] = await requestCorrection(as(rita), target, 'manual', 'website');
        await ageRequest('crm_lead_attribution_corrections', corr!.id, 8);
        expect(await sqlstateOf(decide(vic, corr!.id)), 'expired').toBe('23514');
        expect(await sourceOf(target)).toBe('manual');
        await inContext(
          asUser,
          as(vic),
          `select public.reject_lead_attribution_correction($1, $2)`,
          [corr!.id, 'Expired without a decision'],
        );
        expect(await sourceOf(target)).toBe('manual');
      });

      it('keeps the policy ledger and audit trail immutable for every runtime login', async () => {
        const write = await sqlstateOf(
          asSession(
            as(adminOne),
            'aal2',
            `insert into public.crm_attribution_policy_changes
               (org_id, previous_policy, requested_policy, reason, requested_by_person_id)
             values ($1, 'TWO_PERSON', 'SINGLE_MANAGER', 'Forged direct insert', $2)`,
            [orgS, adminOne],
          ),
        );
        expect(write, 'direct insert into the policy ledger').toBe('42501');
        const tamper = await sqlstateOf(
          asSession(
            as(adminOne),
            'aal2',
            `update public.audit_logs set severity = 'LOW' where entity_id = $1`,
            [orgS],
          ),
        );
        expect(tamper, 'app_user rewriting the audit log').toBe('42501');
        const ownerTamper = await sqlstateOf(
          owner.query(
            `update public.audit_logs set severity = 'LOW'
             where entity_id = $1 and action = 'organization.attribution_policy_activated'`,
            [orgS],
          ),
        );
        // 0011 revokes UPDATE/DELETE on audit_logs from app_owner too (and triggers refuse both).
        expect(ownerTamper, 'even the owner cannot rewrite an audit entry').toBe('42501');
      });

      it('grants no other login (platform, worker, auth, admin) any path to the policy or the decisions', async () => {
        const { rows } = await owner.query<{ login: string; fn: string; can: boolean }>(
          `select l as login, f as fn, has_function_privilege(l, f, 'execute') as can
           from unnest(array['app_platform','app_worker','app_auth','app_admin']) l,
                unnest(array[
                  'public.request_attribution_policy_change(text, text, text)',
                  'public.approve_attribution_policy_change(uuid, text)',
                  'public.reject_attribution_policy_change(uuid, text, text)',
                  'public.apply_lead_attribution_correction(uuid, text)',
                  'public.reject_lead_attribution_correction(uuid, text, text)',
                  'public.crm_assert_recent_mfa(text)',
                  'public.crm_requester_still_authorised(uuid, text, uuid, uuid, boolean)',
                  'public.crm_independent_scope(text, uuid, timestamptz)']) f`,
        );
        expect(rows.filter((r) => r.can)).toEqual([]);
        const tables = await owner.query<{ login: string; can: boolean }>(
          `select l as login,
                  has_table_privilege(l, 'public.crm_attribution_policy_changes', 'select,insert,update,delete') as can
           from unnest(array['app_platform','app_worker','app_auth','app_admin']) l`,
        );
        expect(tables.rows.filter((r) => r.can)).toEqual([]);
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
