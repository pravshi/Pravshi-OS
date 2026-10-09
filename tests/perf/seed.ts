import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from '@neondatabase/serverless';

/**
 * Phase 12 (Wave D, audit §4.4) — the shared plan-stable dataset for the
 * perf harness: tests/perf/query-plans.test.ts (Tier-1 plan assertions),
 * tests/perf/overview-concurrency.test.ts (the F-12-01 regression), and the
 * Tier-2 baseline runner (scripts/perf/run-baseline.ts).
 *
 * Contract (phase12-architecture-audit.md §4.4): two orgs; per org
 * ≈ 20k deals, 5k companies, 5k contacts, 50k activities, 20k tasks,
 * 100k notifications, 200k audit rows, 10k jobs — sized so the planner's
 * index choices are not small-table artefacts. Seeding is set-based SQL
 * (one INSERT … SELECT FROM generate_series per table per org) and runs
 * in seconds; ANALYZE is run over every seeded table before the dataset is
 * handed out, because a plan assertion against un-analysed tables asserts
 * nothing.
 *
 * Determinism: every seeded row id is md5('perf:<kind>:<org>:<n>')::uuid,
 * mirrored by perfId() below, so tests can name individual rows (the probe
 * project, a sample company) without a lookup. One exception: the org's
 * default pipeline row, which is provisioned by the org-insert trigger
 * (0039) with a random id and adopted by lookup — nothing outside this
 * module ever referenced the pipeline by id (the measured surfaces join
 * deals → stages; they never look a pipeline up). Distributions are modular
 * arithmetic on the series index, so expected counts/sums are computable
 * ground truth — the suites still read them back through the owner
 * connection rather than trusting the formulae.
 *
 * Idempotence: ensurePerfDataset() runs its whole check → seed → verify
 * sequence inside ONE transaction on ONE dedicated client, serialized
 * across suites and processes by a transaction-scoped advisory lock taken
 * as the transaction's first statement. A concurrent caller blocks on
 * the lock until the holder commits, then re-reads and sees the finished
 * dataset (and verifies it); if the holder fails, its transaction rolls
 * back and the next caller seeds from an empty slate. A half-seeded
 * dataset can therefore never be committed — let alone observed — which
 * PR #70 CI round 1 proved the previous shape allowed: the lock and the
 * statements were on one client, but each statement autocommitted, so
 * two suites overlapped mid-seed (the second suite observing orgs with
 * zero companies) and the partial rows stayed behind. Round 2 then proved
 * the duplicate-default-pipeline error was NOT (only) that race: with
 * the lock holding, both suites still died on the same insert, ~38 s
 * apart — because every organization is born with a default pipeline.
 * The organizations_seed_system_roles trigger (0008, body grown by 0039)
 * calls seed_default_pipeline(new.id) inside the very statement that
 * creates the org, so the seed's own transaction creates the conflicting
 * row before its explicit pipeline insert runs; no cross-suite
 * serialization can fix a conflict the caller manufactures itself.
 * seedOrg therefore ADOPTS the provisioned pipeline (see there). If the
 * orgs already exist, the dataset is
 * verified against the scale it was seeded at (detected from the
 * companies count) and returned; a dataset whose counts match NO single
 * scale is a loud error, never a silent top-up — a half-seeded dataset
 * would teach false confidence (audit §4.4/Q5).
 *
 * Scale: 1 is the contracted size. Smaller scales exist for the Tier-2
 * runner's --ci mode (trend lines on a throwaway database, §4.4) — the
 * Tier-1 suites assert dataset.scale === 1 before believing a plan.
 *
 * Owner connection only (DATABASE_URL_MIGRATE, app_owner): fixtures are
 * seeded the way every other suite in this repo seeds — the owner bypasses
 * RLS; the services under measurement run as app_user through
 * withAuthorizedDb and meet the real policies.
 */

export const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

export const PERF_ORG_SLUGS = ['perf-t1-a', 'perf-t1-b'] as const;

/** Base (scale-1) row counts per org, straight from audit §4.4. */
export const PERF_BASE_COUNTS = {
  companies: 5_000,
  contacts: 5_000,
  deals: 20_000,
  activities: 50_000,
  tasks: 20_000,
  notifications: 100_000,
  auditLogs: 200_000,
  jobs: 10_000,
} as const;

/** Fixed (unscaled) fixture shapes per org. */
export const PERF_PEOPLE_PER_ORG = 100;
export const PERF_PROJECTS_PER_ORG = 20;
export const PERF_WORKFLOWS_PER_ORG = 2;
export const PERF_EXECUTIONS_PER_ORG = 300;

/** The probe person's GLOBAL grants: everything the measured surfaces read. */
export const PERF_PROBE_PERMISSIONS = [
  'companies.view',
  'contacts.view',
  'deals.view',
  'activities.view',
  'projects.view',
  'tasks.view',
  'jobs.view',
  'workflows.view',
  'reports.view',
  'notifications.view',
  'people.view',
  'ai.use',
  'ai.usage.manage',
  'integrations.view',
  'integrations.manage',
] as const;

export interface PerfCounts {
  companies: number;
  contacts: number;
  deals: number;
  activities: number;
  tasks: number;
  notifications: number;
  auditLogs: number;
  jobs: number;
}

export interface PerfDataset {
  orgA: string;
  orgB: string;
  /** Org A's operator (people row #1): ACTIVE engagement + GLOBAL grants. */
  probePersonId: string;
  /** Org A project #1 — the tasks-list probe target. */
  probeProjectId: string;
  /** One org A company id (baseline detail reads). */
  sampleCompanyId: string;
  /** One org A deal id (AI-assist target in the baseline). */
  sampleDealId: string;
  scale: number;
  counts: PerfCounts;
}

/** Row counts per org at a given scale (the seed/verify contract). */
export function expectedCounts(scale: number): PerfCounts {
  const at = (base: number) => Math.max(1, Math.round(base * scale));
  return {
    companies: at(PERF_BASE_COUNTS.companies),
    contacts: at(PERF_BASE_COUNTS.contacts),
    deals: at(PERF_BASE_COUNTS.deals),
    activities: at(PERF_BASE_COUNTS.activities),
    tasks: at(PERF_BASE_COUNTS.tasks),
    notifications: at(PERF_BASE_COUNTS.notifications),
    auditLogs: at(PERF_BASE_COUNTS.auditLogs),
    jobs: at(PERF_BASE_COUNTS.jobs),
  };
}

/** md5('perf:<kind>:<org>:<n>') formatted as a uuid — equals the SQL cast. */
export function perfId(kind: string, orgIndex: number, n: number): string {
  const hex = createHash('md5').update(`perf:${kind}:${orgIndex}:${n}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const idSql = (kind: string, orgIndex: number, expr: string) =>
  `md5('perf:${kind}:${orgIndex}:' || (${expr}))::uuid`;

/* ── one org's worth of set-based inserts (run inside the seed lock) ────── */

async function seedOrg(client: PoolClient, orgIndex: 0 | 1, orgId: string, counts: PerfCounts) {
  const q = (text: string, params: unknown[] = []) => client.query(text, params);
  const person = (expr: string) => idSql('person', orgIndex, expr);

  // People: #1 is the probe operator; the rest are notification recipients
  // and record owners. Codes satisfy people_code_format per org.
  await q(
    `insert into public.people (id, org_id, code, full_legal_name, person_status, date_of_birth, personal_email)
     select ${person('g.i')}, $1, 'PERF-2026-' || lpad(g.i::text, 4, '0'),
            'Perf Person ' || g.i, 'ACTIVE'::public.person_status, '1990-01-01',
            'perf-' || ${orgIndex} || '-' || g.i || '@example.test'
       from generate_series(1, ${PERF_PEOPLE_PER_ORG}) as g(i)`,
    [orgId],
  );

  // The probe person's ACTIVE engagement (authz.is_active reads engagements).
  const dept = await q(
    `insert into public.departments (org_id, code, name) values ($1, 'PERF', 'Perf Dept') returning id`,
    [orgId],
  );
  await q(
    `insert into public.engagements (org_id, person_id, department_id, engagement_type, status, start_date)
     values ($1, $2, $3, 'EMPLOYEE', 'ACTIVE'::public.engagement_status, current_date)`,
    [orgId, perfId('person', orgIndex, 1), (dept.rows[0] as { id: string }).id],
  );

  // The probe person's GLOBAL role. A catalogue key that does not resolve
  // throws (the mkRoleFor lesson from Phase 11: unverified grants are how
  // a suite ends up probing with an actor that cannot act).
  const role = await q(
    `insert into public.roles (org_id, key, name) values ($1, 'PERFPROBE', 'Perf Probe') returning id`,
    [orgId],
  );
  const roleId = (role.rows[0] as { id: string }).id;
  for (const permission of PERF_PROBE_PERMISSIONS) {
    const { rowCount } = await q(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, p.id, 'GLOBAL'::public.access_scope from public.permissions p where p.key = $2`,
      [roleId, permission],
    );
    if (rowCount !== 1) {
      throw new Error(`perf seed: permission key ${permission} is not in the catalogue`);
    }
  }
  await q(`insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`, [
    perfId('person', orgIndex, 1),
    roleId,
    orgId,
  ]);

  // Pipeline: ADOPT the default pipeline the org was born with. The
  // organizations insert in ensurePerfDataset fired the
  // organizations_seed_system_roles trigger, whose seed_default_pipeline
  // call (0039) already created a live default ('Sales Pipeline', random
  // id, six stages at positions 0..5) inside this same transaction — a
  // second default would violate pipelines_one_default_per_org, which is
  // exactly what PR #70 CI rounds 1–2 hit. Replace the provisioned stages
  // (unreferenced — no deals exist yet, so the owner may hard-delete them)
  // with this harness's deterministic stages and bind deals to the
  // adopted pipeline's id below.
  const pipeline = await q(
    `select id from public.pipelines where org_id = $1 and is_default and deleted_at is null`,
    [orgId],
  );
  const pipelineId = (pipeline.rows[0] as { id: string } | undefined)?.id;
  if (!pipelineId) {
    throw new Error(
      'perf seed: organization has no provisioned default pipeline — the ' +
        'organizations_seed_system_roles / seed_default_pipeline contract (0039) is broken',
    );
  }
  await q(`delete from public.pipeline_stages where pipeline_id = $1`, [pipelineId]);
  // 6 stages (positions 1..6 = NEW..LOST; 5 won, 6 lost).
  await q(
    `insert into public.pipeline_stages (id, org_id, pipeline_id, name, position, probability, is_won, is_lost)
     select ${idSql('stage', orgIndex, 'g.i')}, $1, $2,
            (array['NEW','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'])[g.i], g.i,
            (g.i * 15)::numeric, g.i = 5, g.i = 6
       from generate_series(1, 6) as g(i)`,
    [orgId, pipelineId],
  );

  // Companies. Every 500th name carries the search probe token 'Zephyr'.
  await q(
    `insert into public.companies (id, org_id, name, owner_person_id, created_at, updated_at)
     select ${idSql('company', orgIndex, 'g.i')}, $1,
            case when g.i % 500 = 0 then 'Zephyr Holdings ' || g.i else 'Perf Company ' || g.i end,
            ${person('((g.i - 1) % 100) + 1')},
            now() - make_interval(days => g.i % 180),
            now() - make_interval(days => g.i % 180)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.companies],
  );

  // Contacts, each pinned to a company (same org — the composite FKs hold).
  await q(
    `insert into public.contacts (id, org_id, company_id, first_name, last_name, email, owner_person_id, created_at, updated_at)
     select ${idSql('contact', orgIndex, 'g.i')}, $1,
            ${idSql('company', orgIndex, `((g.i - 1) % ${counts.companies}) + 1`)},
            'Perf', 'Contact ' || g.i,
            'perf-contact-' || ${orgIndex} || '-' || g.i || '@example.test',
            ${person('((g.i - 1) % 100) + 1')},
            now() - make_interval(days => g.i % 180),
            now() - make_interval(days => g.i % 180)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.contacts],
  );

  // Deals. Stage cycles 1..6 in step with pipeline_stage_id; created_at is
  // spread over the last 90 days at noon (session tz) so range filters in
  // the analytics probes have clean edges; value/currency are modular, so
  // per-currency sums are exact ground truth.
  await q(
    `insert into public.deals (
       id, org_id, title, company_id, contact_id, value, currency, stage,
       probability, closed_at, pipeline_id, pipeline_stage_id, owner_person_id,
       created_at, updated_at)
     select ${idSql('deal', orgIndex, 'g.i')}, $1, 'Perf Deal ' || g.i,
            ${idSql('company', orgIndex, `((g.i - 1) % ${counts.companies}) + 1`)},
            ${idSql('contact', orgIndex, `((g.i - 1) % ${counts.contacts}) + 1`)},
            (1000 + (g.i % 500) * 137)::numeric,
            case when g.i % 5 = 0 then 'USD' else 'INR' end,
            (array['NEW','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'])[(g.i % 6) + 1],
            g.i % 101,
            case when (g.i % 6) + 1 >= 5
                 then (current_date - (g.i % 90)) + interval '13 hours' else null end,
            $3,
            ${idSql('stage', orgIndex, '(g.i % 6) + 1')},
            ${person('((g.i - 1) % 100) + 1')},
            (current_date - (g.i % 90)) + interval '12 hours',
            (current_date - (g.i % 90)) + interval '12 hours' + make_interval(hours => g.i % 10)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.deals, pipelineId],
  );

  // Activities across the three entity kinds.
  await q(
    `insert into public.activities (
       id, org_id, entity_type, entity_id, type, subject, occurred_at, owner_person_id,
       created_at, updated_at)
     select ${idSql('activity', orgIndex, 'g.i')}, $1,
            (array['company','contact','deal'])[(g.i % 3) + 1],
            case (g.i % 3)
              when 0 then ${idSql('company', orgIndex, `((g.i - 1) % ${counts.companies}) + 1`)}
              when 1 then ${idSql('contact', orgIndex, `((g.i - 1) % ${counts.contacts}) + 1`)}
              else ${idSql('deal', orgIndex, `((g.i - 1) % ${counts.deals}) + 1`)}
            end,
            (array['CALL','EMAIL','MEETING','NOTE'])[(g.i % 4) + 1],
            'Perf activity ' || g.i,
            now() - make_interval(days => g.i % 60),
            ${person('((g.i - 1) % 100) + 1')},
            now() - make_interval(days => g.i % 60),
            now() - make_interval(days => g.i % 60)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.activities],
  );

  // Work projects + tasks. Project #1 is the list probe's target.
  await q(
    `insert into public.work_projects (id, org_id, name, created_at, updated_at)
     select ${idSql('project', orgIndex, 'g.i')}, $1, 'Perf Project ' || g.i, now(), now()
       from generate_series(1, ${PERF_PROJECTS_PER_ORG}) as g(i)`,
    [orgId],
  );
  await q(
    `insert into public.work_tasks (
       id, org_id, project_id, title, status, priority, due_date, assignee_person_id,
       created_at, updated_at)
     select ${idSql('task', orgIndex, 'g.i')}, $1,
            ${idSql('project', orgIndex, `((g.i - 1) % ${PERF_PROJECTS_PER_ORG}) + 1`)},
            'Perf Task ' || g.i,
            (array['todo','in_progress','done'])[(g.i % 3) + 1],
            (array['low','medium','high','urgent'])[(g.i % 4) + 1],
            case when g.i % 2 = 0 then current_date + (g.i % 60) else null end,
            ${person('((g.i - 1) % 100) + 1')},
            now() - make_interval(days => g.i % 60),
            now() - make_interval(days => g.i % 60)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.tasks],
  );
  // Subtasks: every 12th task gains one, inheriting its parent's project
  // (the parent/project guard triggers require exactly that).
  const subtaskCount = Math.floor(counts.tasks / 12);
  if (subtaskCount > 0) {
    await q(
      `insert into public.work_tasks (
         id, org_id, project_id, title, status, priority, assignee_person_id, parent_task_id,
         created_at, updated_at)
       select ${idSql('subtask', orgIndex, 'g.j')}, $1,
              ${idSql('project', orgIndex, `(((g.j * 12) - 1) % ${PERF_PROJECTS_PER_ORG}) + 1`)},
              'Perf Subtask ' || g.j,
              (array['todo','in_progress','done'])[(g.j % 3) + 1],
              'medium',
              ${person('((g.j - 1) % 100) + 1')},
              ${idSql('task', orgIndex, 'g.j * 12')},
              now(), now()
         from generate_series(1, $2::int) as g(j)`,
      [orgId, subtaskCount],
    );
  }

  // Notifications: 100 recipients round-robin; person #1's rows sit at odd
  // series indexes and are ALL unread, everyone else alternates — the
  // unread-count probe's expected value is exactly counts/100.
  await q(
    `insert into public.notifications (id, org_id, person_id, type, title, message, read_at, created_at)
     select ${idSql('notification', orgIndex, 'g.i')}, $1,
            ${person('((g.i - 1) % 100) + 1')},
            (array['TASK_ASSIGNED','TASK_DUE','TASK_OVERDUE','DEAL_UPDATED','DEAL_STAGE_CHANGED','WORKFLOW_SUCCEEDED'])[(g.i % 6) + 1],
            'Perf notification ' || g.i, 'Seeded by the Phase 12 perf harness.',
            case when g.i % 2 = 0 then now() - make_interval(hours => g.i % 48) else null end,
            now() - make_interval(days => g.i % 30)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.notifications],
  );

  // Jobs: 60% succeeded / 20% failed / 10% dead_letter / 10% pending, and
  // most pending rows are due — the claim probe's hunting ground.
  await q(
    `insert into public.jobs (
       id, org_id, type, status, priority, payload, attempts, max_attempts, next_run_at,
       created_at, updated_at)
     select ${idSql('job', orgIndex, 'g.i')}, $1,
            (array['workflow_run','scheduled_trigger','retry','webhook','cleanup','notification','email'])[(g.i % 7) + 1],
            case when g.i % 10 <= 5 then 'succeeded'
                 when g.i % 10 <= 7 then 'failed'
                 when g.i % 10 = 8 then 'dead_letter'
                 else 'pending' end,
            g.i % 5, '{}'::jsonb, 0, 5,
            case when g.i % 10 = 9 and g.i % 5 != 0
                 then now() - make_interval(seconds => g.i % 3600)
                 else now() + interval '1 hour' end,
            now() - make_interval(days => g.i % 30),
            now() - make_interval(days => g.i % 30)
       from generate_series(1, $2::int) as g(i)`,
    [orgId, counts.jobs],
  );

  // Workflows + executions so the overview's workflow metrics are non-vacuous.
  await q(
    `insert into public.workflows (id, org_id, name, trigger)
     select ${idSql('workflow', orgIndex, 'g.i')}, $1, 'Perf Workflow ' || g.i, '{"type":"manual"}'::jsonb
       from generate_series(1, ${PERF_WORKFLOWS_PER_ORG}) as g(i)`,
    [orgId],
  );
  await q(
    `insert into public.workflow_executions (
       id, org_id, workflow_id, workflow_version, dedup_key, status, trigger_type, created_at)
     select ${idSql('execution', orgIndex, 'g.i')}, $1,
            ${idSql('workflow', orgIndex, `(g.i % ${PERF_WORKFLOWS_PER_ORG}) + 1`)},
            1, 'perf-exec-' || ${orgIndex} || '-' || g.i,
            (array['SUCCEEDED','FAILED','RUNNING','PENDING'])[(g.i % 4) + 1],
            'manual', now() - make_interval(days => g.i % 30)
       from generate_series(1, ${PERF_EXECUTIONS_PER_ORG}) as g(i)`,
    [orgId],
  );

  // Integrations dressing for the Tier-2 baseline: one webhooks connection
  // + three subscriptions on deal.won, so a fan-out emit enqueues real
  // delivery jobs. Signing secrets are resolved in-worker at delivery
  // time, never at enqueue — NULL vault columns are correct here.
  await q(
    `insert into public.integration_connections (id, org_id, provider_key, display_name, status)
     values (${idSql('connection', orgIndex, '1')}, $1, 'webhooks', 'Perf Webhooks', 'CONNECTED')`,
    [orgId],
  );
  await q(
    `insert into public.integration_webhook_subscriptions (id, org_id, url, events, active, created_by)
     select ${idSql('subscription', orgIndex, 'g.i')}, $1,
            'https://example.test/perf-hook-' || g.i, array['deal.won'], true, $2
       from generate_series(1, 3) as g(i)`,
    [orgId, perfId('person', orgIndex, 1)],
  );
}

/** Audit rows need partitions for the months they land in (last 30 days). */
async function ensureAuditPartitions(client: PoolClient) {
  // The maintenance function ensures the current month forward.
  await client.query(`select public.ensure_audit_log_partitions(2)`);
  // The previous month is outside its window; create it exactly the way
  // the function would (same name, RLS, owner policy, revocations).
  await client.query(`
    do $do$
    declare
      v_start date := (date_trunc('month', now()) - interval '1 month')::date;
      v_end date := (date_trunc('month', now()))::date;
      v_name text := 'audit_logs_' || to_char(v_start, 'YYYY_MM');
    begin
      if to_regclass('public.' || quote_ident(v_name)) is null then
        execute format(
          'create table public.%I partition of public.audit_logs for values from (%L) to (%L)',
          v_name, v_start, v_end);
        execute format('alter table public.%I enable row level security', v_name);
        execute format('alter table public.%I force row level security', v_name);
        execute format(
          'create policy %I on public.%I for all to app_owner using (true) with check (true)',
          v_name || '_owner_all', v_name);
        execute format('revoke all on public.%I from app_user, app_admin', v_name);
      end if;
    end
    $do$`);
}

async function seedAuditRows(client: PoolClient, orgIndex: 0 | 1, orgId: string, n: number) {
  await client.query(
    `insert into public.audit_logs (id, org_id, occurred_at, action, entity_type, result)
     select ${idSql('audit', orgIndex, 'g.i')}, $1,
            now() - make_interval(days => g.i % 30, hours => g.i % 24),
            'perf.seeded', 'deal', 'SUCCESS'::public.audit_result
       from generate_series(1, $2::int) as g(i)`,
    [orgId, n],
  );
}

async function readCounts(client: PoolClient, orgId: string): Promise<PerfCounts> {
  const { rows } = await client.query<{
    companies: string;
    contacts: string;
    deals: string;
    activities: string;
    tasks: string;
    notifications: string;
    audit_logs: string;
    jobs: string;
  }>(
    `select
       (select count(*) from public.companies where org_id = $1) as companies,
       (select count(*) from public.contacts where org_id = $1) as contacts,
       (select count(*) from public.deals where org_id = $1) as deals,
       (select count(*) from public.activities where org_id = $1) as activities,
       (select count(*) from public.work_tasks where org_id = $1) as tasks,
       (select count(*) from public.notifications where org_id = $1) as notifications,
       (select count(*) from public.audit_logs where org_id = $1) as audit_logs,
       (select count(*) from public.jobs where org_id = $1) as jobs`,
    [orgId],
  );
  const row = rows[0]!;
  return {
    companies: Number(row.companies),
    contacts: Number(row.contacts),
    deals: Number(row.deals),
    activities: Number(row.activities),
    tasks: Number(row.tasks),
    notifications: Number(row.notifications),
    auditLogs: Number(row.audit_logs),
    jobs: Number(row.jobs),
  };
}

/**
 * Verify an existing dataset: its counts must equal one scale's expected
 * counts — exactly for the plan-gated tables, at-least for the two tables
 * the product itself appends to while running (jobs: fan-out enqueues;
 * audit_logs: mutation audit writes). Returns the detected scale.
 */
function verifyExisting(actual: PerfCounts, orgSlug: string): number {
  const scale = actual.companies / PERF_BASE_COUNTS.companies;
  const expected = expectedCounts(scale);
  // work_tasks holds the seeded tasks PLUS their subtasks (one per 12).
  const expectedWithSubtasks: PerfCounts = {
    ...expected,
    tasks: expected.tasks + Math.floor(expected.tasks / 12),
  };
  const exact: (keyof PerfCounts)[] = [
    'companies',
    'contacts',
    'deals',
    'activities',
    'tasks',
    'notifications',
  ];
  for (const key of exact) {
    if (actual[key] !== expectedWithSubtasks[key]) {
      throw new Error(
        `perf seed: existing dataset for ${orgSlug} is inconsistent — ${key} has ` +
          `${actual[key]} rows, expected ${expectedWithSubtasks[key]} at detected scale ${scale}. ` +
          `Refusing to plan-assert against a partial dataset; delete the perf orgs and re-run.`,
      );
    }
  }
  for (const key of ['jobs', 'auditLogs'] as const) {
    if (actual[key] < expected[key]) {
      throw new Error(
        `perf seed: existing dataset for ${orgSlug} is short on ${key} — ` +
          `${actual[key]} rows, expected at least ${expected[key]} at scale ${scale}.`,
      );
    }
  }
  return scale;
}

/**
 * Seed (or verify and reuse) the perf dataset. The entire sequence —
 * advisory lock, existing-dataset check, seeding, verification — runs
 * inside one transaction on one dedicated owner client, so concurrent
 * callers serialize on the lock AND never observe (or leave behind) a
 * partially seeded dataset: the holder's writes become visible atomically
 * at COMMIT, and any failure rolls them all back.
 */
export async function ensurePerfDataset(scale = 1): Promise<PerfDataset> {
  const client = await owner.connect();
  try {
    await client.query('begin');
    try {
      // Transaction-scoped: released by COMMIT/ROLLBACK, so a holder that
      // dies mid-seed takes its lock — and its uncommitted rows — with it.
      await client.query(`select pg_advisory_xact_lock(hashtext('pravshi-perf-seed-v1')::bigint)`);
      const existing = await client.query<{ id: string }>(
        `select id from public.organizations where slug = $1`,
        [PERF_ORG_SLUGS[0]],
      );
      if (existing.rows[0]) {
        const orgA = existing.rows[0].id;
        const orgB = (
          await client.query<{ id: string }>(
            `select id from public.organizations where slug = $1`,
            [PERF_ORG_SLUGS[1]],
          )
        ).rows[0]!.id;
        const detected = verifyExisting(await readCounts(client, orgA), PERF_ORG_SLUGS[0]);
        verifyExisting(await readCounts(client, orgB), PERF_ORG_SLUGS[1]);
        await client.query('commit');
        return {
          orgA,
          orgB,
          probePersonId: perfId('person', 0, 1),
          probeProjectId: perfId('project', 0, 1),
          sampleCompanyId: perfId('company', 0, 1),
          sampleDealId: perfId('deal', 0, 1),
          scale: detected,
          counts: expectedCounts(detected),
        };
      }

      const counts = expectedCounts(scale);
      const orgIds: string[] = [];
      for (const orgIndex of [0, 1] as const) {
        const org = await client.query<{ id: string }>(
          `insert into public.organizations (name, slug) values ($1, $2) returning id`,
          [`PERF HARNESS ${orgIndex === 0 ? 'A' : 'B'}`, PERF_ORG_SLUGS[orgIndex]],
        );
        orgIds.push(org.rows[0]!.id);
      }
      await ensureAuditPartitions(client);
      for (const orgIndex of [0, 1] as const) {
        await seedOrg(client, orgIndex, orgIds[orgIndex]!, counts);
        await seedAuditRows(client, orgIndex, orgIds[orgIndex]!, counts.auditLogs);
      }
      await client.query(
        `analyze public.companies, public.contacts, public.deals, public.activities,
                 public.work_tasks, public.work_projects, public.notifications, public.jobs,
                 public.people, public.pipeline_stages, public.workflows,
                 public.workflow_executions, public.audit_logs`,
      );
      await client.query('commit');
      return {
        orgA: orgIds[0]!,
        orgB: orgIds[1]!,
        probePersonId: perfId('person', 0, 1),
        probeProjectId: perfId('project', 0, 1),
        sampleCompanyId: perfId('company', 0, 1),
        sampleDealId: perfId('deal', 0, 1),
        scale,
        counts,
      };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}
