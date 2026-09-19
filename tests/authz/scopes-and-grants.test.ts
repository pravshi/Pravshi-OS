import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import {
  assertTargetAffected,
  requirePermission,
  type AuthorizationRequest,
} from '@/lib/authz/require-permission';
import type { TargetEntity } from '@/lib/authz/targets';
import {
  headersFor,
  mapLimit,
  mkAccount,
  mkCustomRole,
  mkDept,
  mkOrg,
  mkPerson,
  outcomeOf,
  ownerPool,
  refusal,
  runId,
  type Account,
} from './fixtures';

/**
 * Task 1.15 — scope and record grants reach a target only through the table's RLS policy.
 *
 * documents.view belongs to a table Phase 3 will bring, so this suite creates a probe table whose
 * SELECT policy is the database.md 4.2 template for it. Since Task 1.16 the template is complete
 * except for one branch:
 *
 *   TEAM      owner = me  or  reports_to_me(owner)   both halves, the helper arrived in Task 1.16
 *   PROJECT   is_project_member(project)             the helper is Phase 4, so false
 *
 * The table is registered as a target through a test-only probe of exactly the shape of the real
 * ones in src/lib/authz/targets.ts. Everything else is real: sessions, role assignments, record
 * grants, requirePermission(), withAuthorizedDb() and RLS.
 */

vi.mock('@/lib/authz/targets', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/authz/targets')>();
  const { sql: query } = await import('drizzle-orm');
  type Tx = Parameters<typeof real.probeTarget>[1];
  const probe = async (tx: Tx, id: string) =>
    (
      await tx.execute<{ visible: boolean }>(
        query`select exists (select 1 from public._authz_scope_probe s where s.id = ${id}::uuid) as visible`,
      )
    ).rows[0]?.visible === true;
  return {
    ...real,
    isTargetEntity: (value: unknown) => value === 'scope_probe' || real.isTargetEntity(value),
    probeTarget: (entity: string, tx: Tx, id: string) =>
      entity === 'scope_probe' ? probe(tx, id) : real.probeTarget(entity as TargetEntity, tx, id),
  };
});

const PROBE = 'scope_probe' as unknown as TargetEntity;

const owner = ownerPool();
const RUN = runId();
const CODE = `G${RUN.toUpperCase()}`;

/** Probe rows, by what each one is for. */
const R = {
  self: randomUUID(),
  colleague: randomUUID(),
  secondary: randomUUID(),
  outside: randomUUID(),
  teamOwn: randomUUID(),
  projectOwn: randomUUID(),
  collapseOwn: randomUUID(),
  granted: randomUUID(),
  ungranted: randomUUID(),
  expired: randomUUID(),
  revoked: randomUUID(),
  wrongType: randomUUID(),
  wrongPermission: randomUUID(),
  revokeLater: randomUUID(),
  foreign: randomUUID(),
};

let orgA = '';
let orgB = '';
let revokeLaterGrant = '';
let orgARows: string[] = [];
const acct: Record<string, Account> = {};

const onProbe = (holder: Account, id: string, extra: Partial<AuthorizationRequest> = {}) =>
  requirePermission(headersFor(holder.cookie), {
    permission: 'documents.view',
    target: { entity: PROBE, id },
    ...extra,
  });

const scopeOf = async (holder: Account, permission = 'documents.view') =>
  (await requirePermission(headersFor(holder.cookie), { permission })).scope;

const codeOf = async (promise: Promise<unknown>) => (await outcomeOf(promise)).code;

const visibleRows = async (ctx: AuthContext) =>
  (
    await withAuthorizedDb(ctx, (tx) =>
      tx.execute<{ id: string }>(sql`select id from public._authz_scope_probe`),
    )
  ).rows.map((r) => r.id);

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(owner, `sg-${RUN}-a`), mkOrg(owner, `sg-${RUN}-b`)]);
  const [d1, d2, d3, dB] = await Promise.all([
    mkDept(owner, orgA, `${CODE}_D1`),
    mkDept(owner, orgA, `${CODE}_D2`),
    mkDept(owner, orgA, `${CODE}_D3`),
    mkDept(owner, orgB, `${CODE}_B`),
  ]);
  const [docsGlobal, docsTeam, docsProject, docsPrivileged] = await Promise.all([
    mkCustomRole(owner, orgA, `DOCS_GLOBAL_${CODE}`, [['documents.view', 'GLOBAL']]),
    mkCustomRole(owner, orgA, `DOCS_TEAM_${CODE}`, [['documents.view', 'TEAM']]),
    mkCustomRole(owner, orgA, `DOCS_PROJECT_${CODE}`, [['documents.view', 'PROJECT']]),
    mkCustomRole(owner, orgA, `DOCS_PRIVILEGED_${CODE}`, [
      ['compensation.view', 'GLOBAL'],
      ['documents.view', 'SELF'],
    ]),
  ]);

  type Input = Parameters<typeof mkAccount>[1];
  const inA = (label: string, rest: Partial<Input> = {}): Input => ({
    org: orgA,
    dept: d1,
    run: RUN,
    label,
    roles: ['EMPLOYEE'],
    ...rest,
  });
  const specs: [key: string, input: Input][] = [
    ['self', inA('sgself')],
    ['colleague', inA('sgcolleague')],
    ['deptHead', inA('sgdepthead', { roles: ['EMPLOYEE', 'HR_MANAGER'] })],
    ['global', inA('sgglobal', { customRoles: [docsGlobal] })],
    ['team', inA('sgteam', { roles: [], customRoles: [docsTeam] })],
    ['project', inA('sgproject', { roles: [], customRoles: [docsProject] })],
    ['collapse', inA('sgcollapse', { customRoles: [docsProject] })],
    ['grantee', inA('sggrantee')],
    ['noBase', inA('sgnobase', { roles: [] })],
    ['suspendedHolder', inA('sgsuspended', { engagement: 'SUSPENDED' })],
    ['privilegedHolder', inA('sgprivileged', { roles: [], customRoles: [docsPrivileged] })],
    ['managerHolder', inA('sgmanager')],
    ['foreign', { org: orgB, dept: dB, run: RUN, label: 'sgforeign', roles: ['EMPLOYEE'] }],
  ];
  const created = await mapLimit(specs, 4, ([, input]) => mkAccount(owner, input));
  specs.forEach(([key], i) => {
    acct[key] = created[i]!;
  });

  const [grantorA, grantorB] = await Promise.all([
    mkPerson(owner, orgA, 'Grantor A'),
    mkPerson(owner, orgB, 'Grantor B'),
  ]);
  await owner.query(
    `insert into public.person_departments (org_id, person_id, department_id) values ($1, $2, $3)`,
    [orgA, acct.deptHead!.personId, d2],
  );
  // One reporting line, for the TEAM branch: colleague reports to the TEAM-scoped holder.
  await owner.query(`update public.engagements set manager_person_id = $1 where person_id = $2`, [
    acct.team!.personId,
    acct.colleague!.personId,
  ]);

  // ── the probe table ──
  const colleague = acct.colleague!.personId;
  const rows: [id: string, org: string, ownerPerson: string, department: string][] = [
    [R.self, orgA, acct.self!.personId, d1],
    [R.colleague, orgA, colleague, d1],
    [R.secondary, orgA, colleague, d2],
    [R.outside, orgA, colleague, d3],
    [R.teamOwn, orgA, acct.team!.personId, d1],
    [R.projectOwn, orgA, acct.project!.personId, d1],
    [R.collapseOwn, orgA, acct.collapse!.personId, d1],
    ...[
      R.granted,
      R.ungranted,
      R.expired,
      R.revoked,
      R.wrongType,
      R.wrongPermission,
      R.revokeLater,
    ].map((id): [string, string, string, string] => [id, orgA, colleague, d3]),
    [R.foreign, orgB, acct.foreign!.personId, dB],
  ];
  orgARows = rows.filter(([, org]) => org === orgA).map(([id]) => id);

  // Seeded before RLS is armed, as tests/db/authorized.test.ts does: FORCE subjects the owner to
  // the table's policies, and the only policy is for app_user.
  await owner.query(`
    create table if not exists public._authz_scope_probe (
      id uuid primary key,
      org_id uuid not null,
      owner_person_id uuid not null,
      department_id uuid not null,
      project_id uuid
    );
    alter table public._authz_scope_probe disable row level security;
    truncate public._authz_scope_probe;
  `);
  await owner.query(
    `insert into public._authz_scope_probe (id, org_id, owner_person_id, department_id)
     select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[])`,
    [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])],
  );
  await owner.query(`
    alter table public._authz_scope_probe enable row level security;
    alter table public._authz_scope_probe force row level security;
    drop policy if exists authz_scope_probe_select on public._authz_scope_probe;
    create policy authz_scope_probe_select on public._authz_scope_probe
      for select to app_user
      using (
        org_id = (select authz.org_id())
        and (select authz.is_active())
        and (
          case (select authz.scope_for('documents.view'))
            when 'GLOBAL'     then true
            when 'DEPARTMENT' then department_id = any ((select authz.my_departments())::uuid[])
            when 'TEAM'       then owner_person_id = (select authz.person_id())
                                   or (select authz.reports_to_me(owner_person_id))
            when 'PROJECT'    then false
            when 'SELF'       then owner_person_id = (select authz.person_id())
            else false
          end
          or (select authz.has_record_grant('scope_probe', id, 'documents.view'))
        )
      );
    revoke all on public._authz_scope_probe from app_user, app_admin;
    grant select on public._authz_scope_probe to app_user;
  `);

  // ── record grants, issued from the owner connection as the Task 1.9 suite does ──
  const issue = async (
    holder: Account,
    entityId: string,
    opts: {
      org?: string;
      by?: string;
      entityType?: string;
      permission?: string;
      expired?: boolean;
    } = {},
  ) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by,
            granted_at, expires_at, reason)
         select $1, $2, $3, $4, p.id, $5,
                case when $6::boolean then now() - interval '2 days' else now() end,
                case when $6::boolean then now() - interval '1 day' end,
                'Task 1.15 authorization suite'
         from public.permissions p where p.key = $7
         returning id`,
        [
          opts.org ?? orgA,
          opts.entityType ?? 'scope_probe',
          entityId,
          holder.personId,
          opts.by ?? grantorA,
          opts.expired ?? false,
          opts.permission ?? 'documents.view',
        ],
      )
    ).rows[0]!.id;
  const revokeNow = (id: string) =>
    owner.query(`update public.record_grants set revoked_at = now() where id = $1`, [id]);

  const grantee = acct.grantee!;
  await Promise.all([
    issue(grantee, R.granted),
    issue(grantee, R.expired, { expired: true }),
    issue(grantee, R.revoked).then(revokeNow),
    issue(grantee, R.wrongType, { entityType: 'document' }),
    issue(grantee, R.wrongPermission, { permission: 'documents.download' }),
    issue(acct.noBase!, R.granted),
    issue(acct.suspendedHolder!, R.granted),
    issue(acct.privilegedHolder!, R.granted),
    issue(acct.managerHolder!, R.granted, { permission: 'roles.manage' }),
    issue(acct.foreign!, R.granted, { org: orgB, by: grantorB }),
  ]);
  revokeLaterGrant = await issue(grantee, R.revokeLater);
}, 300_000);

afterAll(async () => {
  await owner.query('drop table if exists public._authz_scope_probe').catch(() => undefined);
  await owner.end().catch(() => undefined);
});

// ── 1. scope ─────────────────────────────────────────────────────────────────────

describe('scope reaches a target only through the table policy (database.md 4.2)', () => {
  it('GLOBAL reaches every row in the organization, and none in another', async () => {
    for (const id of [R.colleague, R.secondary, R.outside]) {
      expect((await onProbe(acct.global!, id)).scope, id).toBe('GLOBAL');
    }
    expect(await codeOf(onProbe(acct.global!, R.foreign))).toBe('NOT_FOUND');
  });

  it('DEPARTMENT reaches the primary and the secondary department, and nothing outside them', async () => {
    const head = acct.deptHead!;
    expect((await onProbe(head, R.colleague)).scope).toBe('DEPARTMENT');
    expect((await onProbe(head, R.secondary)).scope).toBe('DEPARTMENT');
    expect(await codeOf(onProbe(head, R.outside))).toBe('NOT_FOUND');
  });

  it('TEAM reaches the caller’s own rows and everyone who reports to them', async () => {
    // colleague's engagement names the TEAM holder as manager; self's does not.
    expect(await scopeOf(acct.team!)).toBe('TEAM');
    expect((await onProbe(acct.team!, R.teamOwn)).scope).toBe('TEAM');
    expect((await onProbe(acct.team!, R.colleague)).scope).toBe('TEAM');
    expect(await codeOf(onProbe(acct.team!, R.self))).toBe('NOT_FOUND');
  });

  it('PROJECT reaches nothing until authz.is_project_member() exists', async () => {
    expect(await scopeOf(acct.project!)).toBe('PROJECT');
    expect(await codeOf(onProbe(acct.project!, R.projectOwn))).toBe('NOT_FOUND');
    expect(await codeOf(onProbe(acct.project!, R.colleague))).toBe('NOT_FOUND');
  });

  it('SELF reaches the caller’s own rows only', async () => {
    expect((await onProbe(acct.self!, R.self)).scope).toBe('SELF');
    expect(await codeOf(onProbe(acct.self!, R.colleague))).toBe('NOT_FOUND');
  });

  it('resolves one effective scope, so PROJECT outranks SELF and the caller’s own row fails closed', async () => {
    // EMPLOYEE grants documents.view at SELF and the custom role grants it at PROJECT. The enum
    // order makes PROJECT the effective scope, and until is_project_member() exists that branch is
    // false: narrower than either role alone, never wider. Recorded for the 4.2 rollout.
    expect(await scopeOf(acct.collapse!)).toBe('PROJECT');
    expect(await codeOf(onProbe(acct.collapse!, R.collapseOwn))).toBe('NOT_FOUND');
  });

  it('checks minScope before the target, so a shortfall says nothing about the row', async () => {
    const head = acct.deptHead!;
    expect((await onProbe(head, R.colleague, { minScope: 'DEPARTMENT' })).scope).toBe('DEPARTMENT');
    for (const id of [R.colleague, R.outside, randomUUID()]) {
      expect(await codeOf(onProbe(head, id, { minScope: 'GLOBAL' })), id).toBe('SCOPE_DENIED');
    }
  });

  it('follows department membership on the very next request', async () => {
    const head = acct.deptHead!;
    expect((await onProbe(head, R.secondary)).scope).toBe('DEPARTMENT');
    await owner.query(
      `update public.person_departments set deleted_at = now() where person_id = $1`,
      [head.personId],
    );
    expect(await codeOf(onProbe(head, R.secondary))).toBe('NOT_FOUND');
    expect((await onProbe(head, R.colleague)).scope).toBe('DEPARTMENT');
  });
});

// ── 2. record grants ─────────────────────────────────────────────────────────────

describe('record grants (founder decision 5)', () => {
  it('reach the one record they name, and leave the scope exactly as it was', async () => {
    expect((await onProbe(acct.grantee!, R.granted)).scope).toBe('SELF');
    expect(await codeOf(onProbe(acct.grantee!, R.ungranted))).toBe('NOT_FOUND');
  });

  it('cannot satisfy minScope', async () => {
    expect(await codeOf(onProbe(acct.grantee!, R.granted, { minScope: 'DEPARTMENT' }))).toBe(
      'SCOPE_DENIED',
    );
  });

  it('cannot stand in for a permission the caller does not hold', async () => {
    expect(await codeOf(onProbe(acct.noBase!, R.granted))).toBe('FORBIDDEN');
  });

  it('reach nothing once expired or revoked', async () => {
    expect(await codeOf(onProbe(acct.grantee!, R.expired))).toBe('NOT_FOUND');
    expect(await codeOf(onProbe(acct.grantee!, R.revoked))).toBe('NOT_FOUND');
  });

  it('apply only to the entity type and the action they name', async () => {
    expect(await codeOf(onProbe(acct.grantee!, R.wrongType))).toBe('NOT_FOUND');
    expect(await codeOf(onProbe(acct.grantee!, R.wrongPermission))).toBe('NOT_FOUND');
  });

  it('stop on the very next request once revoked', async () => {
    expect((await onProbe(acct.grantee!, R.revokeLater)).scope).toBe('SELF');
    await owner.query(`update public.record_grants set revoked_at = now() where id = $1`, [
      revokeLaterGrant,
    ]);
    expect(await codeOf(onProbe(acct.grantee!, R.revokeLater))).toBe('NOT_FOUND');
  });

  it('bypass neither engagement gating nor mandatory MFA', async () => {
    expect(await codeOf(onProbe(acct.suspendedHolder!, R.granted))).toBe('FORBIDDEN');
    expect(await codeOf(onProbe(acct.privilegedHolder!, R.granted))).toBe('STEP_UP_REQUIRED');
  });

  it('never cross an organization boundary', async () => {
    expect(await codeOf(onProbe(acct.foreign!, R.granted))).toBe('NOT_FOUND');
  });

  it('never confer role management or any other administrative capability', async () => {
    const holder = acct.managerHolder!;
    for (const permission of ['roles.manage', 'permissions.manage', 'record_grants.manage']) {
      expect(
        await codeOf(requirePermission(headersFor(holder.cookie), { permission })),
        permission,
      ).toBe('FORBIDDEN');
      expect(await codeOf(onProbe(holder, R.granted, { permission })), permission).toBe(
        'FORBIDDEN',
      );
    }
    const authorization = await requirePermission(headersFor(holder.cookie), {
      permission: 'people.view',
    });
    const { rows } = await withAuthorizedDb(authorization.ctx, (tx) =>
      tx.execute<{ manage: boolean; scope: string | null }>(
        sql`select authz.has('roles.manage') as manage, authz.scope_for('roles.manage')::text as scope`,
      ),
    );
    expect(rows[0]).toEqual({ manage: false, scope: null });
  });
});

// ── 3. one chain ─────────────────────────────────────────────────────────────────

describe('the work after the check runs under the same chain', () => {
  it('sees through withAuthorizedDb() exactly what the policy let the check see', async () => {
    const grantee = await onProbe(acct.grantee!, R.granted);
    const seen = await visibleRows(grantee.ctx);
    expect(seen).toContain(R.granted);
    for (const hidden of [
      R.ungranted,
      R.expired,
      R.revoked,
      R.wrongType,
      R.wrongPermission,
      R.colleague,
      R.self,
      R.foreign,
    ]) {
      expect(seen, hidden).not.toContain(hidden);
    }

    const global = await onProbe(acct.global!, R.outside);
    expect([...(await visibleRows(global.ctx))].sort()).toEqual([...orgARows].sort());
  });
});

// ── 4. the real Phase 1 targets ──────────────────────────────────────────────────

describe('the real Phase 1 tables follow the same template', () => {
  it('lets a DEPARTMENT people.view reach that department, and stops at the tenant', async () => {
    const head = acct.deptHead!;
    const person = (id: string) => ({
      permission: 'people.view',
      target: { entity: 'person' as const, id },
    });
    expect((await requirePermission(headersFor(head.cookie), person(head.personId))).scope).toBe(
      'DEPARTMENT',
    );
    // Task 1.16: the colleague sharing their department is now reachable …
    expect(
      (await requirePermission(headersFor(head.cookie), person(acct.colleague!.personId))).scope,
    ).toBe('DEPARTMENT');
    // … and another organization's person is not, at any scope.
    expect(
      await codeOf(requirePermission(headersFor(head.cookie), person(acct.foreign!.personId))),
    ).toBe('NOT_FOUND');
  });
});

// ── 5. writes ────────────────────────────────────────────────────────────────────

describe('assertTargetAffected()', () => {
  it('passes a write that reached its target, and conceals one that reached nothing', async () => {
    const authorization = await onProbe(acct.grantee!, R.granted);
    await expect(assertTargetAffected(authorization, 1)).resolves.toBeUndefined();

    const error = await refusal(assertTargetAffected(authorization, 0));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.requestId).toBe(authorization.requestId);
    const { rows } = await owner.query(
      `select entity_type, entity_id, severity, result::text as result, metadata
       from public.audit_logs where request_id = $1`,
      [authorization.requestId],
    );
    expect(rows).toEqual([
      {
        entity_type: 'scope_probe',
        entity_id: R.granted,
        severity: 'LOW',
        result: 'DENIED',
        metadata: { reason: 'TARGET_NOT_VISIBLE' },
      },
    ]);

    await expect(assertTargetAffected({ ...authorization }, 0)).rejects.toThrow(TypeError);
  });
});
