import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  grantRole,
  mkDept,
  mkEngagement,
  mkOrg,
  mkPerson,
  outcomeOf,
  ownerPool,
  runId,
} from './fixtures';

/**
 * Task 1.15 — the database does not simply believe the context it is handed.
 *
 * Session resolution is replaced here so the context can be crafted: a stale identity, a
 * mismatched organization, a forged assurance claim. Every decision is still made by the real
 * database through the real requirePermission(). The point is the second barrier — whatever the
 * application layer passes to withAuthorizedDb(), authz.person_id(), authz.org_id() and
 * authz.aal() re-derive the truth from the tables.
 */

const mocks = vi.hoisted(() => ({ resolveAuthContext: vi.fn() }));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  resolveAuthContext: mocks.resolveAuthContext,
}));

const { requirePermission } = await import('@/lib/authz/require-permission');

const owner = ownerPool();
const RUN = runId();
const CODE = `C${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let active = '';
let inactive = '';
let privileged = '';
let enrolled = '';
let enrolledLogin = '';

type Ctx = { personId: string; orgId: string; aal: 'aal1' | 'aal2' };

/** policies.acknowledge is held by EMPLOYEE and FINANCE alike, at SELF. */
const as = (ctx: Ctx) => {
  mocks.resolveAuthContext.mockResolvedValue(ctx);
  return requirePermission(new Headers(), { permission: 'policies.acknowledge' });
};

const auditCount = async (requestId: string | undefined) =>
  (
    await owner.query<{ n: number }>(
      `select count(*)::int n from public.audit_logs where request_id = $1`,
      [requestId],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(owner, `ci-${RUN}-a`), mkOrg(owner, `ci-${RUN}-b`)]);
  const dept = await mkDept(owner, orgA, `${CODE}_A`);

  enrolledLogin = (
    await owner.query<{ id: string }>(
      `insert into auth.auth_users (name, email, two_factor_enabled)
       values ('Enrolled', $1, true) returning id`,
      [`enrolled.${RUN}@example.test`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into auth.auth_two_factors (user_id, secret, backup_codes, verified)
     values ($1, 'fixture-encrypted-seed', 'fixture-encrypted-codes', true)`,
    [enrolledLogin],
  );

  [active, inactive, privileged, enrolled] = await Promise.all([
    mkPerson(owner, orgA, 'Active'),
    mkPerson(owner, orgA, 'Inactive', { status: 'INACTIVE' }),
    mkPerson(owner, orgA, 'Privileged Without Factor'),
    mkPerson(owner, orgA, 'Enrolled', { authUserId: enrolledLogin }),
  ]);
  await Promise.all(
    [active, inactive, privileged, enrolled].map((p) => mkEngagement(owner, orgA, p, dept)),
  );
  await Promise.all([
    grantRole(owner, active, orgA, 'EMPLOYEE'),
    grantRole(owner, inactive, orgA, 'EMPLOYEE'),
    grantRole(owner, privileged, orgA, 'FINANCE'),
    grantRole(owner, enrolled, orgA, 'FINANCE'),
  ]);
}, 120_000);

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

describe('identity is re-derived, not believed', () => {
  it('accepts a context the database agrees with', async () => {
    const authorization = await as({ personId: active, orgId: orgA, aal: 'aal1' });
    expect(authorization.scope).toBe('SELF');
  });

  it('refuses, without an audit entry, a person the database no longer accepts', async () => {
    for (const personId of [inactive, '00000000-0000-4000-8000-000000000000']) {
      const outcome = await outcomeOf(as({ personId, orgId: orgA, aal: 'aal1' }));
      expect(outcome.code, personId).toBe('UNAUTHENTICATED');
      expect(await auditCount(outcome.requestId)).toBe(0);
    }
  });

  it('refuses a context whose organization is not the person’s own', async () => {
    expect((await outcomeOf(as({ personId: active, orgId: orgB, aal: 'aal1' }))).code).toBe(
      'UNAUTHENTICATED',
    );
  });
});

describe('assurance is re-derived, not believed', () => {
  it('refuses a claim of aal2 for a privileged person with no factor at all', async () => {
    const outcome = await outcomeOf(as({ personId: privileged, orgId: orgA, aal: 'aal2' }));
    expect(outcome.code).toBe('STEP_UP_REQUIRED');
    expect(outcome.assurance).toEqual({ required: 'aal2', current: 'aal1' });
  });

  it('honours aal2 only while the login is enrolled AND its factor is verified', async () => {
    const ctx = { personId: enrolled, orgId: orgA, aal: 'aal2' } as const;
    expect((await as(ctx)).aal).toBe('aal2');

    await owner.query(`update auth.auth_two_factors set verified = false where user_id = $1`, [
      enrolledLogin,
    ]);
    expect((await outcomeOf(as(ctx))).code).toBe('STEP_UP_REQUIRED');

    await owner.query(`update auth.auth_two_factors set verified = true where user_id = $1`, [
      enrolledLogin,
    ]);
    await owner.query(`update auth.auth_users set two_factor_enabled = false where id = $1`, [
      enrolledLogin,
    ]);
    expect((await outcomeOf(as(ctx))).code).toBe('STEP_UP_REQUIRED');

    await owner.query(`update auth.auth_users set two_factor_enabled = true where id = $1`, [
      enrolledLogin,
    ]);
    expect((await as(ctx)).aal).toBe('aal2');

    // The Task 1.15 hardening: a factor row gone out of band, the flag still set.
    await owner.query(`delete from auth.auth_two_factors where user_id = $1`, [enrolledLogin]);
    expect((await outcomeOf(as(ctx))).code).toBe('STEP_UP_REQUIRED');
  });

  it('requires aal2 of a privileged person whose own session claims only aal1', async () => {
    expect((await outcomeOf(as({ personId: privileged, orgId: orgA, aal: 'aal1' }))).code).toBe(
      'STEP_UP_REQUIRED',
    );
  });
});
