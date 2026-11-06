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
    bob = await mkPersonIn(orgB, deptB, 'Bob');

    await grant(orgA, alice, 'GLOBAL', [...VIEW_EDIT, 'leads.assign']);
    await grant(orgA, carol, 'SELF', VIEW_EDIT);
    await grant(orgA, dave, 'SELF', VIEW_EDIT);
    await grant(orgA, erin, 'DEPARTMENT', VIEW_EDIT);
    await grant(orgA, frank, 'TEAM', VIEW_EDIT);
    await grant(orgB, bob, 'GLOBAL', [...VIEW_EDIT, 'leads.assign']);

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
    it('runs the guards, stamping and scope helper with invoker rights, and the mutator as app_owner', async () => {
      const { rows } = await owner.query<{
        proname: string;
        prosecdef: boolean;
        owner: string;
        config: string[] | null;
      }>(
        `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in (
           'guard_crm_lead_attribution', 'guard_crm_lead_owner_change', 'crm_stamp_actor',
           'crm_lead_in_edit_scope', 'apply_lead_attribution_correction')
         order by p.proname`,
      );
      const by = new Map(rows.map((r) => [r.proname, r]));
      // A SECURITY DEFINER guard sees current_user = its owner (app_owner) and never fires.
      expect(by.get('guard_crm_lead_attribution')!.prosecdef).toBe(false);
      expect(by.get('guard_crm_lead_owner_change')!.prosecdef).toBe(false);
      expect(by.get('crm_stamp_actor')!.prosecdef).toBe(false);
      expect(by.get('crm_lead_in_edit_scope')!.prosecdef).toBe(false);
      // The guards' "current_user = app_owner" exemption holds only inside this function.
      expect(by.get('apply_lead_attribution_correction')!.prosecdef).toBe(true);
      expect(by.get('apply_lead_attribution_correction')!.owner).toBe('app_owner');
      for (const r of rows) expect(r.config, r.proname).toContain('search_path=""');
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

    it('binds reassigned_by_person_id to the caller and requires a visible lead', async () => {
      const forged = await sqlstateOf(
        inContext(
          asUser,
          at(alice, orgA),
          `insert into public.crm_lead_assignment_history (org_id, lead_id, to_person_id, reassigned_by_person_id, reason)
           values ($1, $2, $3, $4, 'forged reassigner')`,
          [orgA, leadCarol, alice, carol],
        ),
      );
      expect(forged).toBe('42501');
      await inContext(
        asUser,
        at(alice, orgA),
        `insert into public.crm_lead_assignment_history (org_id, lead_id, to_person_id, reassigned_by_person_id, reason)
         values ($1, $2, $3, $3, 'self as reassigner')`,
        [orgA, leadCarol, alice],
      );
      const invisible = await sqlstateOf(
        inContext(
          asUser,
          at(carol, orgA),
          `insert into public.crm_lead_assignment_history (org_id, lead_id, to_person_id, reassigned_by_person_id, reason)
           values ($1, $2, $3, $3, 'not my lead')`,
          [orgA, leadAlice, carol],
        ),
      );
      expect(invisible).toBe('42501');
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

  describe('edit scope (crm_lead_in_edit_scope)', () => {
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
            `select public.crm_lead_in_edit_scope($1::uuid, $2::uuid) as v`,
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
        `select public.crm_lead_in_edit_scope($1::uuid, null) as v`,
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
