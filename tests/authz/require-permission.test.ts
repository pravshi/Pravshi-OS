import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revokeSessionsFor } from '@/lib/auth/session';
import { toErrorEnvelope } from '@/lib/authz/errors';
import { withPermission } from '@/lib/authz/http';
import { requirePermission, type AuthorizationRequest } from '@/lib/authz/require-permission';
import {
  PASSWORD,
  headersFor,
  mapLimit,
  mkAccount,
  mkCustomRole,
  mkDept,
  mkLogin,
  mkOrg,
  ownerPool,
  refusal,
  runId,
  signIn,
  type Account,
} from './fixtures';

/**
 * Task 1.15 — requirePermission() against a real database, through real sessions.
 *
 * Authentication, eligibility, capability, breadth, concealment and the denial trail. No account
 * here holds a sensitive permission at GLOBAL scope, so mandatory MFA never intervenes; MFA,
 * scopes with record grants, and the security.md matrix each have their own file.
 */

const owner = ownerPool();
const RUN = runId();
const CODE = `Q${RUN.toUpperCase()}`;

type AccountInput = Parameters<typeof mkAccount>[1];

/**
 * Every engagement status except ACTIVE. NOTICE_PERIOD is refused like the rest until the founder
 * decision recorded in 0005 says otherwise.
 */
const INELIGIBLE_STATUSES = [
  'PRE_ONBOARDING',
  'ONBOARDING',
  'NOTICE_PERIOD',
  'SUSPENDED',
  'OFFBOARDING',
  'ARCHIVED',
] as const;

let orgA = '';
let orgB = '';
let strangerCookie = '';
let sessionTokens: string[] = [];
const acct: Record<string, Account> = {};

const ask = (cookie: string, request: AuthorizationRequest, extra: Record<string, string> = {}) =>
  requirePermission(headersFor(cookie, extra), request);

const personTarget = (id: string): AuthorizationRequest => ({
  permission: 'people.view',
  target: { entity: 'person', id },
});

type AuditRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  result: string;
  severity: string;
  actor_person_id: string;
  org_id: string;
  metadata: Record<string, unknown>;
  actor_ip: string | null;
  user_agent: string | null;
};

const auditRows = async (requestId: string) =>
  (
    await owner.query<AuditRow>(
      `select action, entity_type, entity_id, result::text as result, severity, actor_person_id,
              org_id, metadata, host(actor_ip) as actor_ip, user_agent
       from public.audit_logs where request_id = $1`,
      [requestId],
    )
  ).rows;

const engagementOf = async (personId: string) =>
  (
    await owner.query<{ id: string }>(`select id from public.engagements where person_id = $1`, [
      personId,
    ])
  ).rows[0]!.id;

beforeAll(async () => {
  let orgSuspended = '';
  let orgDeleted = '';
  [orgA, orgB, orgSuspended, orgDeleted] = await Promise.all([
    mkOrg(owner, `rp-${RUN}-a`),
    mkOrg(owner, `rp-${RUN}-b`),
    mkOrg(owner, `rp-${RUN}-suspended`),
    mkOrg(owner, `rp-${RUN}-deleted`),
  ]);
  const [deptA, deptB, deptS, deptD] = await Promise.all([
    mkDept(owner, orgA, `${CODE}_A`),
    mkDept(owner, orgB, `${CODE}_B`),
    mkDept(owner, orgSuspended, `${CODE}_S`),
    mkDept(owner, orgDeleted, `${CODE}_D`),
  ]);
  const [directory, selfService] = await Promise.all([
    mkCustomRole(owner, orgA, `DIRECTORY_${CODE}`, [['people.view', 'GLOBAL']]),
    mkCustomRole(owner, orgA, `SELFSERVICE_${CODE}`, [['engagements.view', 'SELF']]),
  ]);

  const inA = (label: string, rest: Partial<AccountInput> = {}): AccountInput => ({
    org: orgA,
    dept: deptA,
    run: RUN,
    label,
    roles: ['EMPLOYEE'],
    ...rest,
  });
  const specs: [key: string, input: AccountInput][] = [
    ['employee', inA('employee')],
    ['hrManager', inA('hrmanager', { roles: ['EMPLOYEE', 'HR_MANAGER'] })],
    ['narrowing', inA('narrowing', { roles: ['EMPLOYEE', 'HR_MANAGER'] })],
    ['directory', inA('directory', { customRoles: [directory] })],
    ['selfService', inA('selfservice', { customRoles: [selfService] })],
    ['expiring', inA('expiring')],
    ['revoked', inA('revoked')],
    ['bulkRevoked', inA('bulkrevoked')],
    ['deactivated', inA('deactivated')],
    ['deleted', inA('deleted')],
    ['noEngagement', inA('noengagement', { engagement: null })],
    ['softDeletedEngagement', inA('softdeleted')],
    ['orgB', { org: orgB, dept: deptB, run: RUN, label: 'orgb', roles: ['EMPLOYEE'] }],
    [
      'inSuspendedOrg',
      { org: orgSuspended, dept: deptS, run: RUN, label: 'suspendedorg', roles: ['EMPLOYEE'] },
    ],
    [
      'inDeletedOrg',
      { org: orgDeleted, dept: deptD, run: RUN, label: 'deletedorg', roles: ['EMPLOYEE'] },
    ],
    ...INELIGIBLE_STATUSES.map((status): [string, AccountInput] => [
      `status_${status}`,
      inA(`status${status.toLowerCase().replace(/_/g, '')}`, { engagement: status }),
    ]),
  ];
  const created = await mapLimit(specs, 4, ([, input]) => mkAccount(owner, input));
  specs.forEach(([key], i) => {
    acct[key] = created[i]!;
  });

  const stranger = await mkLogin('stranger', RUN);
  strangerCookie = await signIn(stranger.email);

  // Captured before any test ends a session, so the audit scan below looks for every one of them.
  sessionTokens = (
    await owner.query<{ token: string }>(
      `select token from auth.auth_sessions where user_id = any($1::uuid[])`,
      [[...Object.values(acct).map((a) => a.authUserId), stranger.id]],
    )
  ).rows.map((r) => r.token);

  await Promise.all([
    owner.query(`update public.engagements set deleted_at = now() where person_id = $1`, [
      acct.softDeletedEngagement!.personId,
    ]),
    owner.query(`update public.organizations set status = 'SUSPENDED' where id = $1`, [
      orgSuspended,
    ]),
    owner.query(`update public.organizations set deleted_at = now() where id = $1`, [orgDeleted]),
  ]);
}, 300_000);

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

// ── 1. authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  const expect401 = async (promise: Promise<unknown>) => {
    const error = await refusal(promise);
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.status).toBe(401);
    expect(await auditRows(error.requestId)).toEqual([]);
  };

  it('refuses a request with no session at all, and records nothing', async () => {
    await expect401(requirePermission(new Headers(), { permission: 'people.view' }));
  });

  it('refuses a tampered session cookie', async () => {
    await expect401(ask('better-auth.session_token=forged.value', { permission: 'people.view' }));
  });

  it('refuses a session whose row has expired', async () => {
    await owner.query(
      `update auth.auth_sessions set expires_at = now() - interval '1 day' where user_id = $1`,
      [acct.expiring!.authUserId],
    );
    await expect401(ask(acct.expiring!.cookie, { permission: 'people.view' }));
  });

  it('refuses a session whose row has been revoked', async () => {
    await revokeSessionsFor(acct.revoked!.authUserId);
    await expect401(ask(acct.revoked!.cookie, { permission: 'people.view' }));
  });

  it('refuses a session issued before sessions_revoked_at', async () => {
    await owner.query(
      `update public.people set sessions_revoked_at = now() + interval '1 minute' where id = $1`,
      [acct.bulkRevoked!.personId],
    );
    await expect401(ask(acct.bulkRevoked!.cookie, { permission: 'people.view' }));
  });

  it('refuses an authenticated login that no person points at', async () => {
    await expect401(ask(strangerCookie, { permission: 'people.view' }));
  });

  it('refuses a person who is no longer ACTIVE, and one who is soft-deleted', async () => {
    await owner.query(`update public.people set person_status = 'INACTIVE' where id = $1`, [
      acct.deactivated!.personId,
    ]);
    await expect401(ask(acct.deactivated!.cookie, { permission: 'people.view' }));
    await owner.query(`update public.people set deleted_at = now() where id = $1`, [
      acct.deleted!.personId,
    ]);
    await expect401(ask(acct.deleted!.cookie, { permission: 'people.view' }));
  });
});

// ── 2. eligibility ───────────────────────────────────────────────────────────────

describe('eligibility — an ACTIVE engagement in an ACTIVE organization', () => {
  const expectIneligible = async (account: Account) => {
    const error = await refusal(ask(account.cookie, { permission: 'people.view' }));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.status).toBe(403);
    const rows = await auditRows(error.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'people.view',
      result: 'DENIED',
      severity: 'HIGH',
      actor_person_id: account.personId,
      metadata: { reason: 'ACCESS_INELIGIBLE' },
    });
  };

  it.each(INELIGIBLE_STATUSES)('refuses an engagement in %s', async (status) => {
    await expectIneligible(acct[`status_${status}`]!);
  });

  it('refuses a person with no engagement, and one whose engagement is soft-deleted', async () => {
    await expectIneligible(acct.noEngagement!);
    await expectIneligible(acct.softDeletedEngagement!);
  });

  it('refuses an organization that is suspended, and one that is soft-deleted', async () => {
    await expectIneligible(acct.inSuspendedOrg!);
    await expectIneligible(acct.inDeletedOrg!);
  });
});

// ── 3. capability and breadth ────────────────────────────────────────────────────

describe('permission and scope', () => {
  it('allows a permission a live role grants, with its scope and the verified assurance', async () => {
    const authorization = await ask(acct.employee!.cookie, { permission: 'people.view' });
    expect(authorization).toMatchObject({ permission: 'people.view', scope: 'SELF', aal: 'aal1' });
    expect(authorization.ctx).toEqual({
      personId: acct.employee!.personId,
      orgId: orgA,
      aal: 'aal1',
    });
  });

  it('refuses a permission no role grants, and records it', async () => {
    const error = await refusal(ask(acct.employee!.cookie, { permission: 'leads.view' }));
    expect(error.code).toBe('FORBIDDEN');
    expect(await auditRows(error.requestId)).toEqual([
      expect.objectContaining({
        action: 'leads.view',
        entity_type: 'permission',
        entity_id: null,
        severity: 'MEDIUM',
        metadata: { reason: 'PERMISSION_DENIED' },
      }),
    ]);
  });

  it('refuses a well-formed key that is not in the catalogue', async () => {
    expect((await refusal(ask(acct.employee!.cookie, { permission: 'nothing.such' }))).code).toBe(
      'FORBIDDEN',
    );
  });

  it('takes the broadest scope across roles', async () => {
    expect((await ask(acct.hrManager!.cookie, { permission: 'people.view' })).scope).toBe(
      'DEPARTMENT',
    );
  });

  it('enforces a minimum breadth by the database enum order, and records the shortfall', async () => {
    const cookie = acct.hrManager!.cookie;
    for (const minScope of ['SELF', 'PROJECT', 'TEAM', 'DEPARTMENT'] as const) {
      expect((await ask(cookie, { permission: 'people.view', minScope })).scope, minScope).toBe(
        'DEPARTMENT',
      );
    }
    const error = await refusal(ask(cookie, { permission: 'people.view', minScope: 'GLOBAL' }));
    expect(error.code).toBe('SCOPE_DENIED');
    expect(error.status).toBe(403);
    expect((await auditRows(error.requestId))[0]!.metadata).toEqual({
      reason: 'SCOPE_DENIED',
      effective_scope: 'DEPARTMENT',
      required_scope: 'GLOBAL',
    });
  });

  it('narrows on the very next request when the broad assignment expires', async () => {
    const cookie = acct.narrowing!.cookie;
    expect((await ask(cookie, { permission: 'people.view' })).scope).toBe('DEPARTMENT');
    await owner.query(
      `update public.person_roles pr
          set granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
         from public.roles r
        where r.id = pr.role_id and pr.person_id = $1 and r.key = 'HR_MANAGER'`,
      [acct.narrowing!.personId],
    );
    expect((await ask(cookie, { permission: 'people.view' })).scope).toBe('SELF');
    // and what HR_MANAGER alone granted is gone entirely
    expect((await refusal(ask(cookie, { permission: 'engagements.transition' }))).code).toBe(
      'FORBIDDEN',
    );
  });
});

// ── 4. protected roles ───────────────────────────────────────────────────────────

describe('the protected-role model is unchanged', () => {
  it('refuses role, permission and grant management to anyone who does not hold it', async () => {
    for (const permission of ['roles.manage', 'permissions.manage', 'record_grants.manage']) {
      expect((await refusal(ask(acct.hrManager!.cookie, { permission }))).code, permission).toBe(
        'FORBIDDEN',
      );
    }
  });
});

// ── 5. nothing the client sends is identity ──────────────────────────────────────

describe('client-supplied identity is ignored', () => {
  it('takes person, organization, role, scope and assurance only from the session', async () => {
    const forged = {
      'x-person-id': acct.hrManager!.personId,
      'x-org-id': orgB,
      'x-role': 'SUPER_ADMIN',
      'x-scope': 'GLOBAL',
      'x-aal': 'aal2',
      authorization: 'Bearer forged',
    };
    const authorization = await ask(acct.employee!.cookie, { permission: 'people.view' }, forged);
    expect(authorization.ctx).toEqual({
      personId: acct.employee!.personId,
      orgId: orgA,
      aal: 'aal1',
    });
    expect(authorization.scope).toBe('SELF');
    expect(
      (await refusal(ask(acct.employee!.cookie, { permission: 'leads.view' }, forged))).code,
    ).toBe('FORBIDDEN');
  });
});

// ── 6. targets and concealment ───────────────────────────────────────────────────

describe('targets are concealed, never confirmed', () => {
  it('allows a target the caller can see, for each registered entity', async () => {
    const own = acct.selfService!;
    const person = await ask(own.cookie, personTarget(own.personId.toUpperCase()));
    expect(person.target).toEqual({ entity: 'person', id: own.personId });

    const engagementId = await engagementOf(own.personId);
    const engagement = await ask(own.cookie, {
      permission: 'engagements.view',
      target: { entity: 'engagement', id: engagementId },
    });
    expect(engagement).toMatchObject({
      scope: 'SELF',
      target: { entity: 'engagement', id: engagementId },
    });
  });

  it('conceals an engagement that belongs to somebody else', async () => {
    const error = await refusal(
      ask(acct.selfService!.cookie, {
        permission: 'engagements.view',
        target: { entity: 'engagement', id: await engagementOf(acct.employee!.personId) },
      }),
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('answers one 404 for a colleague, another tenant, a random id and a malformed one', async () => {
    const ids = [
      acct.hrManager!.personId,
      acct.orgB!.personId,
      '00000000-0000-4000-8000-000000000000',
      "x' or '1'='1",
    ];
    const envelopes = [];
    for (const id of ids) {
      const error = await refusal(ask(acct.employee!.cookie, personTarget(id)));
      expect(error.status, id).toBe(404);
      const { requestId, ...rest } = toErrorEnvelope(error).error;
      expect(requestId).toBe(error.requestId);
      envelopes.push(JSON.stringify(rest));
    }
    expect(new Set(envelopes).size).toBe(1);
  });

  it('records the id that was tried, at low severity', async () => {
    const error = await refusal(ask(acct.employee!.cookie, personTarget(acct.hrManager!.personId)));
    expect(await auditRows(error.requestId)).toEqual([
      expect.objectContaining({
        action: 'people.view',
        entity_type: 'person',
        entity_id: acct.hrManager!.personId,
        severity: 'LOW',
        metadata: { reason: 'TARGET_NOT_VISIBLE' },
      }),
    ]);
  });

  it('refuses before the target when an earlier step refuses, so nothing about it leaks', async () => {
    const hidden = acct.hrManager!.personId;
    const unpermitted = await refusal(
      ask(acct.employee!.cookie, {
        permission: 'leads.view',
        target: { entity: 'person', id: hidden },
      }),
    );
    expect(unpermitted.code).toBe('FORBIDDEN');
    expect((await refusal(ask(acct.status_SUSPENDED!.cookie, personTarget(hidden)))).code).toBe(
      'FORBIDDEN',
    );
  });

  it('reaches a colleague at GLOBAL, and still conceals another tenant', async () => {
    // Task 1.16 gave people the database.md 4.2 template, so a GLOBAL holder now resolves the
    // colleague the SELF policy hid. The tenant boundary is unmoved: org_id comes first.
    const cookie = acct.directory!.cookie;
    expect((await ask(cookie, { permission: 'people.view' })).scope).toBe('GLOBAL');
    const colleague = await ask(cookie, personTarget(acct.employee!.personId));
    expect(colleague.target).toEqual({ entity: 'person', id: acct.employee!.personId });
    expect((await refusal(ask(cookie, personTarget(acct.orgB!.personId)))).code).toBe('NOT_FOUND');
  });
});

// ── 7. the Route Handler wrapper, end to end ─────────────────────────────────────

describe('withPermission() over real sessions', () => {
  const route = withPermission<{ id: string }>(
    { permission: 'people.view', target: (params) => ({ entity: 'person', id: params.id }) },
    async (_request, authorization) =>
      Response.json({ person: authorization.target!.id, scope: authorization.scope }),
  );

  const call = (
    cookie: string | null,
    id: string,
    init: { method?: string; origin?: string } = {},
  ) =>
    route(
      new Request(`http://localhost:3000/api/people/${id}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(init.origin ? { origin: init.origin } : {}),
        },
      }),
      { params: Promise.resolve({ id }) },
    );

  it('serves an authorized request', async () => {
    const res = await call(acct.employee!.cookie, acct.employee!.personId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person: acct.employee!.personId, scope: 'SELF' });
  });

  it('answers 401, 403 and 404 as the section 24 envelope, uncached and without internals', async () => {
    const cases = [
      [null, acct.employee!.personId, 401, 'UNAUTHENTICATED'],
      [acct.status_SUSPENDED!.cookie, acct.status_SUSPENDED!.personId, 403, 'FORBIDDEN'],
      [acct.employee!.cookie, acct.hrManager!.personId, 404, 'NOT_FOUND'],
    ] as const;
    for (const [cookie, id, status, code] of cases) {
      const res = await call(cookie, id);
      expect(res.status, code).toBe(status);
      expect(res.headers.get('cache-control'), code).toBe('no-store');
      const body = (await res.json()) as { error: { code: string } };
      expect(Object.keys(body), code).toEqual(['error']);
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body), code).not.toMatch(
        /people\.view|ACCESS_INELIGIBLE|TARGET_NOT_VISIBLE|NO_IDENTITY|SELF|DEPARTMENT|GLOBAL/,
      );
    }
  });

  it('refuses a cross-origin state change before resolving anything', async () => {
    const res = await call(acct.employee!.cookie, acct.employee!.personId, {
      method: 'POST',
      origin: 'https://attacker.example',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});

// ── 8. the denial trail ──────────────────────────────────────────────────────────

describe('the denial trail', () => {
  it('records the request id, the platform client address and the user agent', async () => {
    const error = await refusal(
      ask(
        acct.employee!.cookie,
        { permission: 'leads.export' },
        { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'authz-suite/1.0' },
      ),
    );
    const rows = await auditRows(error.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: orgA,
      actor_person_id: acct.employee!.personId,
      result: 'DENIED',
      actor_ip: '203.0.113.7',
      user_agent: 'authz-suite/1.0',
    });
  });

  it('drops a client address that is not an IP literal, and still records the denial', async () => {
    const error = await refusal(
      ask(
        acct.employee!.cookie,
        { permission: 'leads.export' },
        { 'x-forwarded-for': 'evil<script>' },
      ),
    );
    expect((await auditRows(error.requestId))[0]!.actor_ip).toBeNull();
  });

  it('writes nothing for an authorized request', async () => {
    const authorization = await ask(acct.employee!.cookie, { permission: 'people.view' });
    expect(await auditRows(authorization.requestId)).toEqual([]);
  });

  it('never writes a session token, a cookie or a password into the audit log', async () => {
    const people = Object.values(acct).map((a) => a.personId);
    const cookieValues = Object.values(acct).flatMap((a) =>
      a.cookie.split(';').map((pair) => pair.slice(pair.indexOf('=') + 1).trim()),
    );
    const needles = [...sessionTokens, ...cookieValues, PASSWORD].filter((s) => s.length >= 12);
    expect(sessionTokens.length).toBeGreaterThanOrEqual(Object.keys(acct).length);
    const { rows } = await owner.query<{ entries: number; hits: number }>(
      `select count(distinct x.id)::int as entries,
              count(*) filter (where strpos(x::text, n.needle) > 0)::int as hits
       from public.audit_logs x
       cross join unnest($2::text[]) as n(needle)
       where x.actor_person_id = any($1::uuid[])`,
      [people, needles],
    );
    expect(rows[0]!.entries).toBeGreaterThan(0);
    expect(rows[0]!.hits).toBe(0);
  });
});

// ── 9. pooled connections ────────────────────────────────────────────────────────

describe('pooled connection isolation', () => {
  it('never lets alternating identities inherit each other', async () => {
    for (let i = 0; i < 6; i++) {
      const [a, b] = await Promise.all([
        ask(acct.employee!.cookie, { permission: 'people.view' }),
        ask(acct.hrManager!.cookie, { permission: 'people.view' }),
      ]);
      expect(a.scope).toBe('SELF');
      expect(b.scope).toBe('DEPARTMENT');
      expect(a.ctx.personId).toBe(acct.employee!.personId);
      expect(b.ctx.personId).toBe(acct.hrManager!.personId);
    }
  });
});

// ── 10. nothing else moved ───────────────────────────────────────────────────────

describe('the rest of the authorization model is unchanged', () => {
  it('has twenty-five authz helpers, and one app_user policy per table (two on login_events)', async () => {
    const helpers = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' order by proname`,
    );
    expect(helpers.rows.map((r) => r.proname)).toEqual([
      'aal',
      'audit_two_factor_change',
      'check_login_lockout',
      'check_rate_limit',
      'clear_login_lockout',
      'consume_password_reset',
      'crm_owner_reachable',
      'has',
      'has_record_grant',
      'in_my_departments',
      'is_active',
      'is_active_person',
      'login_person_active',
      'mfa_enrollment_required',
      'my_departments',
      'next_identity_code',
      'org_id',
      'person_id',
      'record_login_failure',
      'record_password_reset_audit',
      'reports_to_me',
      'request_password_reset',
      'scope_for',
      'stamp_sessions_revoked',
      'update_credential_password',
    ]);
    // The pin above must agree with the migration SQL (0027 added the five
    // lockout/MFA helpers; 0033 added crm_owner_reachable for the CRM
    // owner-visibility RLS policies); if this fails the literal list is stale.
    const migrationSql = readdirSync(join(process.cwd(), 'drizzle'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(process.cwd(), 'drizzle', f), 'utf8'))
      .join('\n');
    const sqlNames = [
      ...new Set(
        [
          ...migrationSql.matchAll(
            /create\s+(?:or\s+replace\s+)?function\s+authz\.([a-z_][a-z0-9_]*)/gi,
          ),
        ].map((m) => m[1]!),
      ),
    ].sort();
    expect(sqlNames).toEqual(helpers.rows.map((r) => r.proname));
    const policies = await owner.query<{ n: number }>(
      `select count(*)::int n from pg_policies
       where schemaname = 'public' and 'app_user' = any(roles) and tablename not like '\\_%'`,
    );
    // 51: login_events carries two app_user policies by design — the invitation flow's
    // scope-driven one plus login_events_select_self from the self-service migration —
    // the CRM migration (0033) adds nine more (select/insert/update on each of
    // companies, contacts, deals), the Track B migrations (0034/0035) add twelve
    // more (select/insert/update on activities, company_contacts, company_links and
    // contact_links), and the Phase 3 sales-pipeline migration (0037) adds eight
    // more (select/insert/update on pipelines and pipeline_stages, select/insert on
    // deal_stage_history).
    expect(policies.rows[0]!.n).toBe(66);
  });

  it('has hardened authz.aal() to require a verified factor (migration 0016)', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef('authz.aal()'::regprocedure) src`,
    );
    expect(rows[0]!.src).toContain('auth.auth_two_factors');
    expect(rows[0]!.src).toMatch(/f\.verified/);
  });
});
