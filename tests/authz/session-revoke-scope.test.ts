import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requirePermission } from '@/lib/authz/require-permission';
import {
  headersFor,
  mkAccount,
  mkCustomRole,
  mkDept,
  mkOrg,
  outcomeOf,
  ownerPool,
  runId,
} from './fixtures';

/**
 * CONCERN-2 (scope escalation): the three session actions in
 * src/app/(app)/admin/users/actions.ts carry minScope: 'GLOBAL' (pinned by
 * tests/guards/session-revoke-scope.test.ts). This file pins the enforcement
 * those specs rely on: a DEPARTMENT-scoped holder of sessions.revoke gets a
 * clean 403 SCOPE_DENIED — audited — instead of reaching the revocation.
 *
 * sessions.revoke is not a sensitive permission, so no MFA step intervenes; the
 * custom role carries nothing else, isolating the breadth question. The GLOBAL
 * positive control is a SUPER_ADMIN, who holds sensitive permissions at GLOBAL
 * and therefore signs in with MFA (aal2).
 */

const owner = ownerPool();
const RUN = runId();

let deptCookie = '';
let saCookie = '';

beforeAll(async () => {
  const org = await mkOrg(owner, `sessscope${RUN}`);
  const dept = await mkDept(owner, org, `SS${RUN}`);
  const deptRole = await mkCustomRole(owner, org, `SESS_DEPT_${RUN}`, [
    ['sessions.revoke', 'DEPARTMENT'],
  ]);
  const holder = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'sessdeptholder',
    customRoles: [deptRole],
  });
  deptCookie = holder.cookie;
  const sa = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'sesssascope',
    roles: ['SUPER_ADMIN'],
    mfa: true,
  });
  saCookie = sa.cookie;
}, 60_000);

afterAll(async () => {
  await owner.end();
});

describe('sessions.revoke with a GLOBAL floor', () => {
  it('denies a DEPARTMENT-scoped holder with SCOPE_DENIED, and audits it', async () => {
    const requestId = randomUUID();
    const out = await outcomeOf(
      requirePermission(headersFor(deptCookie), {
        permission: 'sessions.revoke',
        minScope: 'GLOBAL',
        requestId,
      }),
    );
    expect(out.code).toBe('SCOPE_DENIED');

    const { rows } = await owner.query<{
      result: string;
      severity: string;
      metadata: Record<string, unknown>;
    }>(
      `select result::text as result, severity::text as severity, metadata
       from public.audit_logs
       where request_id = $1 and action = 'sessions.revoke'`,
      [requestId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'DENIED', severity: 'MEDIUM' });
    expect(rows[0]!.metadata).toMatchObject({
      reason: 'SCOPE_DENIED',
      effective_scope: 'DEPARTMENT',
      required_scope: 'GLOBAL',
    });
  });

  it('authorizes the same holder without the floor, at DEPARTMENT scope', async () => {
    const auth = await requirePermission(headersFor(deptCookie), {
      permission: 'sessions.revoke',
    });
    expect(auth.scope).toBe('DEPARTMENT');
  });

  it('authorizes a GLOBAL holder through the floor', async () => {
    const auth = await requirePermission(headersFor(saCookie), {
      permission: 'sessions.revoke',
      minScope: 'GLOBAL',
    });
    expect(auth.scope).toBe('GLOBAL');
  });
});
