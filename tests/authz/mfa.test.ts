import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@/lib/auth/server';
import { resolveAuthContext, revokeSessionsFor } from '@/lib/auth/session';
import { requirePermission } from '@/lib/authz/require-permission';
import {
  PASSWORD,
  assignRoleId,
  cookieFrom,
  headersFor,
  mapLimit,
  mkAccount,
  mkCustomRole,
  mkDept,
  mkOrg,
  outcomeOf,
  ownerPool,
  refusal,
  roleId,
  runId,
  type Account,
} from './fixtures';

/**
 * Task 1.15 — mandatory MFA for privileged people, with real TOTP.
 *
 * Founder decisions 1 and 2: a person needs a verified aal2 session for every protected request
 * when any live role gives them a sensitive permission at GLOBAL scope. It is derived from the
 * catalogue, never from a role name, so a custom role carrying the same capability inherits it;
 * and it is decided per person, so a second, unprivileged role cannot lower it. Decision 3: aal2
 * is honoured only while the database confirms a verified factor (migration 0016).
 */

const owner = ownerPool();
const RUN = runId();
const CODE = `F${RUN.toUpperCase()}`;

let org = '';
const acct: Record<string, Account> = {};

const ask = (who: Account | string, permission = 'people.view') =>
  requirePermission(headersFor(typeof who === 'string' ? who : who.cookie), { permission });

const codeOf = async (promise: Promise<unknown>) => (await outcomeOf(promise)).code;

beforeAll(async () => {
  org = await mkOrg(owner, `mfa-${RUN}`);
  const dept = await mkDept(owner, org, `${CODE}_A`);
  const [auditor, hrDepartment] = await Promise.all([
    mkCustomRole(owner, org, `AUDITOR_${CODE}`, [['audit_logs.view', 'GLOBAL']]),
    mkCustomRole(owner, org, `HR_DEPT_${CODE}`, [
      ['hr.sensitive.view', 'DEPARTMENT'],
      ['people.view', 'SELF'],
    ]),
  ]);

  type Input = Parameters<typeof mkAccount>[1];
  const finance = (label: string, rest: Partial<Input> = {}): Input => ({
    org,
    dept,
    run: RUN,
    label,
    roles: ['FINANCE'],
    ...rest,
  });
  const specs: [key: string, input: Input][] = [
    ['finance', finance('mfafinance')],
    ['financeEnrolled', finance('mfaenrolled', { mfa: true })],
    ['employee', finance('mfaemployee', { roles: ['EMPLOYEE'] })],
    ['tampered', finance('mfatampered')],
    ['disabler', finance('mfadisabler', { mfa: true })],
    ['factorDeleted', finance('mfafactordeleted', { mfa: true })],
    ['factorUnverified', finance('mfafactorunverified', { mfa: true })],
    ['revokedEnrolled', finance('mfarevoked', { mfa: true })],
    ['employeeFinance', finance('mfaemployeefinance', { roles: ['EMPLOYEE', 'FINANCE'] })],
    ['employeeHrManager', finance('mfaemployeehr', { roles: ['EMPLOYEE', 'HR_MANAGER'] })],
    ['expiring', finance('mfaexpiring', { roles: ['EMPLOYEE', 'FINANCE'] })],
    ['auditor', finance('mfaauditor', { roles: [], customRoles: [auditor] })],
    ['hrDepartment', finance('mfahrdept', { roles: [], customRoles: [hrDepartment] })],
    ['suspended', finance('mfasuspended', { engagement: 'SUSPENDED' })],
    ['promoted', finance('mfapromoted', { roles: ['EMPLOYEE'] })],
  ];
  const created = await mapLimit(specs, 3, ([, input]) => mkAccount(owner, input));
  specs.forEach(([key], i) => {
    acct[key] = created[i]!;
  });
}, 300_000);

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

// ── 1. who must step up ──────────────────────────────────────────────────────────

describe('who must step up', () => {
  it('asks a privileged person at aal1 to step up, and records it', async () => {
    const error = await refusal(ask(acct.finance!));
    expect(error.code).toBe('STEP_UP_REQUIRED');
    expect(error.status).toBe(403);
    expect(error.assurance).toEqual({ required: 'aal2', current: 'aal1' });
    const { rows } = await owner.query(
      `select action, entity_type, result::text as result, severity, actor_person_id, metadata
       from public.audit_logs where request_id = $1`,
      [error.requestId],
    );
    expect(rows).toEqual([
      {
        action: 'people.view',
        entity_type: 'permission',
        result: 'DENIED',
        severity: 'MEDIUM',
        actor_person_id: acct.finance!.personId,
        metadata: { reason: 'STEP_UP_REQUIRED', required_aal: 'aal2', current_aal: 'aal1' },
      },
    ]);
  });

  it('allows the same person once the session has verified a second factor', async () => {
    expect(await ask(acct.financeEnrolled!)).toMatchObject({ scope: 'SELF', aal: 'aal2' });
    expect((await ask(acct.financeEnrolled!, 'compensation.view')).scope).toBe('GLOBAL');
    // aal2 satisfies assurance, not capability.
    expect(await codeOf(ask(acct.financeEnrolled!, 'roles.manage'))).toBe('FORBIDDEN');
  });

  it('asks nothing of a person with no sensitive capability at GLOBAL', async () => {
    expect(await ask(acct.employee!)).toMatchObject({ scope: 'SELF', aal: 'aal1' });
  });

  it('covers every request a privileged person makes, whatever else they hold', async () => {
    // EMPLOYEE grants these at SELF; FINANCE makes the person privileged. Per person, not per role.
    for (const permission of ['people.view', 'policies.acknowledge', 'compensation.view']) {
      expect(await codeOf(ask(acct.employeeFinance!, permission)), permission).toBe(
        'STEP_UP_REQUIRED',
      );
    }
  });

  it('comes before the permission check, so a step-up reveals nothing about capability', async () => {
    expect(await codeOf(ask(acct.finance!, 'roles.manage'))).toBe('STEP_UP_REQUIRED');
    expect(await codeOf(ask(acct.finance!, 'nothing.such'))).toBe('STEP_UP_REQUIRED');
  });

  it('comes after eligibility, so an ineligible privileged person is refused as ineligible', async () => {
    expect(await codeOf(ask(acct.suspended!))).toBe('FORBIDDEN');
  });

  it('does not treat a sensitive permission at a narrower scope as privileged', async () => {
    expect(await ask(acct.employeeHrManager!)).toMatchObject({ scope: 'DEPARTMENT', aal: 'aal1' });
    expect(await ask(acct.hrDepartment!, 'hr.sensitive.view')).toMatchObject({
      scope: 'DEPARTMENT',
      aal: 'aal1',
    });
  });

  it('extends to a custom role that carries a sensitive permission at GLOBAL', async () => {
    expect(await codeOf(ask(acct.auditor!, 'audit_logs.view'))).toBe('STEP_UP_REQUIRED');
    expect(await codeOf(ask(acct.auditor!, 'people.view'))).toBe('STEP_UP_REQUIRED');
  });

  it('applies on the very next request after a privileged role is granted', async () => {
    expect(await ask(acct.promoted!)).toMatchObject({ aal: 'aal1' });
    await assignRoleId(owner, acct.promoted!.personId, org, await roleId(owner, org, 'FINANCE'));
    expect(await codeOf(ask(acct.promoted!))).toBe('STEP_UP_REQUIRED');
  });

  it('lifts on the very next request once the privileged assignment expires', async () => {
    expect(await codeOf(ask(acct.expiring!))).toBe('STEP_UP_REQUIRED');
    await owner.query(
      `update public.person_roles pr
          set granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
         from public.roles r
        where r.id = pr.role_id and pr.person_id = $1 and r.key = 'FINANCE'`,
      [acct.expiring!.personId],
    );
    expect(await ask(acct.expiring!)).toMatchObject({ scope: 'SELF', aal: 'aal1' });
  });
});

// ── 2. aal2 is re-derived, never believed ────────────────────────────────────────

describe('aal2 is re-derived on every request (migration 0016)', () => {
  it('refuses a session row edited to claim aal2', async () => {
    const account = acct.tampered!;
    await owner.query(`update auth.auth_sessions set aal = 'aal2' where user_id = $1`, [
      account.authUserId,
    ]);
    // The claim does reach the database: the session layer reads it from the row …
    expect((await resolveAuthContext(headersFor(account.cookie)))?.aal).toBe('aal2');
    // … and authz.aal() refuses it, because no verified factor stands behind it.
    const error = await refusal(ask(account));
    expect(error.code).toBe('STEP_UP_REQUIRED');
    expect(error.assurance).toEqual({ required: 'aal2', current: 'aal1' });
  });

  it('stops honouring aal2 once the factor is disabled through Better Auth', async () => {
    const before = acct.disabler!.cookie;
    expect((await ask(before)).aal).toBe('aal2');

    const res = (await auth.api.disableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(before),
      asResponse: true,
    })) as Response;
    expect(res.ok).toBe(true);

    // The library rotates the session: the old one is gone, and the new one was minted without a
    // second factor being verified on it.
    expect(await codeOf(ask(before))).toBe('UNAUTHENTICATED');
    const after = cookieFrom(res);
    expect(await codeOf(ask(after))).toBe('STEP_UP_REQUIRED');

    // A stale aal2 claim on that login reaches nothing either.
    await owner.query(`update auth.auth_sessions set aal = 'aal2' where user_id = $1`, [
      acct.disabler!.authUserId,
    ]);
    expect(await codeOf(ask(after))).toBe('STEP_UP_REQUIRED');
  });

  it('refuses aal2 when the verified factor row disappears, even with the enrolment flag still set', async () => {
    const account = acct.factorDeleted!;
    expect((await ask(account)).aal).toBe('aal2');
    await owner.query(`delete from auth.auth_two_factors where user_id = $1`, [account.authUserId]);
    const { rows } = await owner.query<{ enabled: boolean }>(
      `select two_factor_enabled as enabled from auth.auth_users where id = $1`,
      [account.authUserId],
    );
    expect(rows[0]!.enabled).toBe(true);
    expect(await codeOf(ask(account))).toBe('STEP_UP_REQUIRED');
  });

  it('refuses aal2 while the factor is unverified, and honours it again once verified', async () => {
    const account = acct.factorUnverified!;
    expect((await ask(account)).aal).toBe('aal2');
    await owner.query(`update auth.auth_two_factors set verified = false where user_id = $1`, [
      account.authUserId,
    ]);
    expect(await codeOf(ask(account))).toBe('STEP_UP_REQUIRED');
    await owner.query(`update auth.auth_two_factors set verified = true where user_id = $1`, [
      account.authUserId,
    ]);
    expect((await ask(account)).aal).toBe('aal2');
  });

  it('lets revocation outrank assurance', async () => {
    const account = acct.revokedEnrolled!;
    expect((await ask(account)).aal).toBe('aal2');
    await revokeSessionsFor(account.authUserId);
    expect(await codeOf(ask(account))).toBe('UNAUTHENTICATED');
  });
});

// ── 3. secrets ───────────────────────────────────────────────────────────────────

describe('secret material', () => {
  it('never writes a TOTP seed into the audit log', async () => {
    const seeds = Object.values(acct)
      .map((a) => a.secret)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    expect(seeds).toHaveLength(5);
    const { rows } = await owner.query<{ entries: number; hits: number }>(
      `select count(distinct x.id)::int as entries,
              count(*) filter (where strpos(x::text, s.seed) > 0)::int as hits
       from public.audit_logs x
       cross join unnest($2::text[]) as s(seed)
       where x.org_id = $1`,
      [org, seeds],
    );
    expect(rows[0]!.entries).toBeGreaterThan(0);
    expect(rows[0]!.hits).toBe(0);
  });
});
