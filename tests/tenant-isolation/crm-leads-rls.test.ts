import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  CODE,
  DB_READY,
  assertForceRls,
  inContext,
  mkOrg,
  mkPerson,
  mkRoleFor,
  sqlstateOf,
  type Ctx,
} from '../workflows/helpers';

/**
 * PR-P1-01: Tenant isolation and RLS security suite for CRM Leads & Lineage tables (migration 0089).
 *
 * Covers:
 *  - public.crm_leads
 *  - public.crm_lead_assignment_history
 *  - public.crm_assignment_cursors
 *  - public.crm_lead_tasks
 *  - public.crm_dedup_candidates
 *  - public.crm_lead_attribution_corrections
 *  - public.re_lead_preferences
 *
 * Verifies that:
 *  1. Every table has RLS enabled and forced.
 *  2. Cross-tenant reads return 0 rows.
 *  3. Cross-tenant writes fail with 42501 (or 0 rows affected).
 */

const ready = DB_READY;
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

const LEADS_PERMS = ['leads.view', 'leads.create', 'leads.edit', 'leads.assign'];

let orgA = '';
let orgB = '';
let alice = ''; // org A, all leads.* grants
let bob = ''; // org B, all leads.* grants
let leadA = '';
let leadA2 = '';
let leadB = '';
let teamA = '';

describe.skipIf(!ready)('PR-P1-01: CRM leads & lineage tenant isolation (live DB)', () => {
  beforeAll(async () => {
    // 1. Force RLS check across all 7 new tables
    await assertForceRls(owner, 'crm_leads');
    await assertForceRls(owner, 'crm_lead_assignment_history');
    await assertForceRls(owner, 'crm_assignment_cursors');
    await assertForceRls(owner, 'crm_lead_tasks');
    await assertForceRls(owner, 'crm_dedup_candidates');
    await assertForceRls(owner, 'crm_lead_attribution_corrections');
    await assertForceRls(owner, 're_lead_preferences');

    // 2. Setup Org A and Org B
    orgA = await mkOrg(owner, `leads-a-${CODE.toLowerCase()}`);
    orgB = await mkOrg(owner, `leads-b-${CODE.toLowerCase()}`);

    alice = await mkPerson(owner, orgA, `Alice ${CODE}`);
    bob = await mkPerson(owner, orgB, `Bob ${CODE}`);

    await mkRoleFor(owner, orgA, alice, `LEADS_OPS_${CODE}`, LEADS_PERMS);
    await mkRoleFor(owner, orgB, bob, `LEADS_OPS_${CODE}`, LEADS_PERMS);

    // Create a team for Org A (needed for crm_assignment_cursors)
    const deptRes = await owner.query<{ id: string }>(
      `select id from public.departments where org_id = $1 limit 1`,
      [orgA],
    );
    const deptA = deptRes.rows[0]!.id;
    const teamRes = await owner.query<{ id: string }>(
      `insert into public.teams (org_id, department_id, name) values ($1, $2, 'Sales Team Alpha') returning id`,
      [orgA, deptA],
    );
    teamA = teamRes.rows[0]!.id;

    // Seed fixture lead 1 for Org A
    const resA = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_leads
         (org_id, full_name, email, primary_phone, stage, source, sla_due_at, owner_person_id, created_by)
       values ($1, 'Lead Alpha', 'alpha@test.example', '+919876500001', 'new', 'manual', now() + interval '15 minutes', $2, $2)
       returning id`,
      [orgA, alice],
    );
    leadA = resA[0]!.id;

    // Seed fixture lead 2 for Org A (for dedup pair)
    const resA2 = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_leads
         (org_id, full_name, email, primary_phone, stage, source, sla_due_at, owner_person_id, created_by)
       values ($1, 'Lead Alpha Duplicate', 'alpha2@test.example', '+919876500003', 'new', 'manual', now() + interval '15 minutes', $2, $2)
       returning id`,
      [orgA, alice],
    );
    leadA2 = resA2[0]!.id;

    // Seed fixture lead for Org B
    const resB = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `insert into public.crm_leads
         (org_id, full_name, email, primary_phone, stage, source, sla_due_at, owner_person_id, created_by)
       values ($1, 'Lead Beta', 'beta@test.example', '+919876500002', 'new', 'website', now() + interval '15 minutes', $2, $2)
       returning id`,
      [orgB, bob],
    );
    leadB = resB[0]!.id;
  });

  afterAll(async () => {
    await asUser.end();
    await owner.end();
  });

  it('isolates crm_leads across tenants and enforces leads permissions', async () => {
    // Org B cannot see Org A leads
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.crm_leads where id = $1`,
      [leadA],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert with orgA's org_id by Bob is rejected by RLS
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.crm_leads
           (org_id, full_name, email, primary_phone, stage, source, sla_due_at, created_by)
         values ($1, 'Intruder', 'intruder@test.example', '+919876500099', 'new', 'manual', now() + interval '15 minutes', $2)`,
        [orgA, bob],
      ),
    );
    expect(badInsertState).toBe('42501');
  });

  it('isolates crm_lead_assignment_history across tenants', async () => {
    // Insert assignment history for Org A
    await inContext(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_lead_assignment_history
         (org_id, lead_id, to_person_id, reassigned_by_person_id, reason)
       values ($1, $2, $3, $3, 'Initial assignment')`,
      [orgA, leadA, alice],
    );

    // Org B cannot see Org A assignment history
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.crm_lead_assignment_history where lead_id = $1`,
      [leadA],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert is rejected
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.crm_lead_assignment_history
           (org_id, lead_id, to_person_id, reassigned_by_person_id, reason)
         values ($1, $2, $3, $3, 'Cross-org intruder')`,
        [orgA, leadA, bob],
      ),
    );
    expect(badInsertState).toBe('42501');
  });

  it('isolates crm_assignment_cursors across tenants', async () => {
    // Insert cursor for Org A
    await inContext(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_assignment_cursors
         (org_id, team_id, last_assigned_person_id)
       values ($1, $2, $3)`,
      [orgA, teamA, alice],
    );

    // Org B cannot see Org A cursor
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.crm_assignment_cursors where org_id = $1`,
      [orgA],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert is rejected
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.crm_assignment_cursors
           (org_id, team_id, last_assigned_person_id)
         values ($1, $2, $3)`,
        [orgA, teamA, bob],
      ),
    );
    expect(badInsertState).toBe('42501');
  });

  it('isolates crm_lead_tasks across tenants', async () => {
    // Insert task for Org A
    const resTask = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_lead_tasks
         (org_id, lead_id, title, task_type, priority, due_at, assignee_person_id, created_by)
       values ($1, $2, 'Follow up with Alpha', 'FOLLOW_UP', 'HIGH', now() + interval '1 day', $3, $3)
       returning id`,
      [orgA, leadA, alice],
    );
    const taskId = resTask[0]!.id;

    // Org B cannot see Org A task
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.crm_lead_tasks where id = $1`,
      [taskId],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert is rejected
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.crm_lead_tasks
           (org_id, lead_id, title, task_type, priority, due_at, assignee_person_id, created_by)
         values ($1, $2, 'Cross-org task', 'FOLLOW_UP', 'MEDIUM', now() + interval '1 day', $3, $3)`,
        [orgA, leadA, bob],
      ),
    );
    expect(badInsertState).toBe('42501');
  });

  it('isolates crm_dedup_candidates across tenants', async () => {
    // Insert dedup candidate for Org A
    await inContext(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_dedup_candidates
         (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score, status)
       values ($1, 'lead', $2, $3, 0.95, 'PENDING')`,
      [orgA, leadA, leadA2],
    );

    // Org B cannot see Org A dedup candidate
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.crm_dedup_candidates where primary_entity_id = $1`,
      [leadA],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert is rejected
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.crm_dedup_candidates
           (org_id, entity_type, primary_entity_id, duplicate_entity_id, confidence_score, status)
         values ($1, 'lead', $2, $3, 0.80, 'PENDING')`,
        [orgA, leadA, leadA2],
      ),
    );
    expect(badInsertState).toBe('42501');
  });

  it('isolates crm_lead_attribution_corrections across tenants', async () => {
    // Insert attribution correction for Org A
    await inContext(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.crm_lead_attribution_corrections
         (org_id, lead_id, field_name, old_value, new_value, reason, requested_by_person_id)
       values ($1, $2, 'source', 'manual', 'website', 'Attribution source entered incorrectly by agent', $3)`,
      [orgA, leadA, alice],
    );

    // Org B cannot see Org A correction
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.crm_lead_attribution_corrections where lead_id = $1`,
      [leadA],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert is rejected
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.crm_lead_attribution_corrections
           (org_id, lead_id, field_name, old_value, new_value, reason, requested_by_person_id)
         values ($1, $2, 'source', 'manual', 'website', 'Attribution cross org hack attempt', $3)`,
        [orgA, leadA, bob],
      ),
    );
    expect(badInsertState).toBe('42501');
  });

  it('isolates re_lead_preferences across tenants', async () => {
    // Insert real estate lead preferences for Org A
    await inContext(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.re_lead_preferences
         (org_id, lead_id, budget_min_paise, budget_max_paise, property_types, bhk_preferences)
       values ($1, $2, 500000000, 1000000000, array['APARTMENT'], array['3BHK'])`,
      [orgA, leadA],
    );

    // Org B cannot see Org A preference
    const seenByBob = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.re_lead_preferences where lead_id = $1`,
      [leadA],
    );
    expect(seenByBob).toHaveLength(0);

    // Cross-org insert is rejected
    const badInsertState = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.re_lead_preferences
           (org_id, lead_id, budget_min_paise, budget_max_paise, property_types, bhk_preferences)
         values ($1, $2, 100000000, 200000000, array['VILLA'], array['4BHK'])`,
        [orgA, leadA],
      ),
    );
    expect(badInsertState).toBe('42501');
  });
});
