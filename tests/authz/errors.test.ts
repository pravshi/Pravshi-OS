import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 1.15 — the authorization contract, with the database replaced.
 *
 * tests/authz/*.test.ts against a real database prove what the chain decides. This file proves
 * the shape around those decisions: the order the questions are asked in, that every unexpected
 * answer fails closed, that a refusal can never become a success, and that nothing internal
 * reaches the wire.
 */

const mocks = vi.hoisted(() => ({
  resolveAuthContext: vi.fn(),
  withAuthorizedDb: vi.fn(),
  writeAuditEntry: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@/env', () => ({ env: { APP_URL: 'https://os.pravshi.com', NODE_ENV: 'test' } }));
vi.mock('@/lib/auth/session', () => ({ resolveAuthContext: mocks.resolveAuthContext }));
vi.mock('@/lib/db/authorized', () => ({ withAuthorizedDb: mocks.withAuthorizedDb }));
vi.mock('@/lib/audit/log', () => ({
  writeAuditEntry: mocks.writeAuditEntry,
  requestMetadata: (_headers: Headers, requestId: string) => ({
    requestId,
    ip: null,
    userAgent: null,
  }),
}));

const { AuthorizationError, toErrorEnvelope, internalErrorEnvelope } =
  await import('@/lib/authz/errors');
const {
  requirePermission,
  decideAuthorization,
  isAuthorization,
  assertAuthorization,
  assertTargetAffected,
} = await import('@/lib/authz/require-permission');
const { withPermission, actionError } = await import('@/lib/authz/http');

type State = Parameters<typeof decideAuthorization>[0];

const CTX = {
  personId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  aal: 'aal1' as const,
};
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

const state = (overrides: Partial<NonNullable<State>> = {}): NonNullable<State> => ({
  person_id: CTX.personId,
  org_id: CTX.orgId,
  active: true,
  aal: 'aal1',
  scope: 'SELF',
  mfa_required: false,
  scope_sufficient: true,
  ...overrides,
});

const dbAnswers = (...rows: unknown[]) => {
  for (const row of rows) mocks.execute.mockResolvedValueOnce({ rows: [row] });
};

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.resolveAuthContext.mockReset().mockResolvedValue(CTX);
  mocks.withAuthorizedDb
    .mockReset()
    .mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ execute: mocks.execute }),
    );
  mocks.writeAuditEntry.mockReset().mockResolvedValue(undefined);
});

// ── the error and its envelope ───────────────────────────────────────────────────

describe('AuthorizationError', () => {
  it('maps every code to its status and one fixed message', () => {
    const expected = {
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      SCOPE_DENIED: 403,
      STEP_UP_REQUIRED: 403,
      NOT_FOUND: 404,
    } as const;
    for (const [code, status] of Object.entries(expected)) {
      const error = new AuthorizationError(code as keyof typeof expected, {
        requestId: 'r',
        reason: 'NO_IDENTITY',
      });
      expect(error.status, code).toBe(status);
      expect(error.message.length, code).toBeGreaterThan(0);
    }
  });

  it('keeps the internal reason off anything that can be serialised or spread', () => {
    const error = new AuthorizationError('FORBIDDEN', {
      requestId: 'r',
      reason: 'PERMISSION_DENIED',
    });
    expect(error.reason).toBe('PERMISSION_DENIED');
    expect(Object.keys(error)).not.toContain('reason');
    expect(JSON.stringify(error)).not.toContain('PERMISSION_DENIED');
    expect(JSON.stringify({ ...error })).not.toContain('PERMISSION_DENIED');
  });

  it('carries an assurance requirement on a step-up and nowhere else', () => {
    const stepUp = new AuthorizationError('STEP_UP_REQUIRED', {
      requestId: 'r',
      reason: 'STEP_UP_REQUIRED',
    });
    expect(stepUp.assurance).toEqual({ required: 'aal2', current: 'aal1' });
    const forbidden = new AuthorizationError('FORBIDDEN', {
      requestId: 'r',
      reason: 'PERMISSION_DENIED',
      assurance: { required: 'aal2', current: 'aal1' },
    });
    expect(forbidden.assurance).toBeUndefined();
  });
});

describe('the envelope', () => {
  it('is built field by field, with nothing but code, message and request id', () => {
    expect(
      toErrorEnvelope(
        new AuthorizationError('NOT_FOUND', { requestId: 'rid', reason: 'TARGET_NOT_VISIBLE' }),
      ),
    ).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'rid' } });
  });

  it('adds the assurance pair to a step-up', () => {
    expect(
      toErrorEnvelope(
        new AuthorizationError('STEP_UP_REQUIRED', {
          requestId: 'rid',
          reason: 'STEP_UP_REQUIRED',
        }),
      ),
    ).toEqual({
      error: {
        code: 'STEP_UP_REQUIRED',
        message: 'Additional verification is required.',
        requestId: 'rid',
        assurance: { required: 'aal2', current: 'aal1' },
      },
    });
  });

  it('is identical for two refusals with different internal reasons', () => {
    const a = toErrorEnvelope(
      new AuthorizationError('FORBIDDEN', { requestId: 'rid', reason: 'ACCESS_INELIGIBLE' }),
    );
    const b = toErrorEnvelope(
      new AuthorizationError('FORBIDDEN', { requestId: 'rid', reason: 'PERMISSION_DENIED' }),
    );
    expect(a).toEqual(b);
  });

  it('says nothing at all about an internal error', () => {
    expect(internalErrorEnvelope('rid')).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong.', requestId: 'rid' },
    });
  });
});

// ── the decision ─────────────────────────────────────────────────────────────────

describe('decideAuthorization() — order, and failing closed', () => {
  const decide = (s: State, minScope?: 'GLOBAL' | 'DEPARTMENT' | 'SELF') =>
    decideAuthorization(s, CTX, minScope);

  it('refuses identity first, for any sign the database no longer accepts the context', () => {
    for (const s of [
      undefined,
      state({ person_id: null }),
      state({ org_id: null }),
      state({ person_id: '44444444-4444-4444-8444-444444444444' }),
      state({ org_id: '55555555-5555-4555-8555-555555555555' }),
    ]) {
      expect(decide(s)).toMatchObject({ allowed: false, code: 'UNAUTHENTICATED', audit: false });
    }
  });

  it('refuses an ineligible identity before looking at assurance or permission', () => {
    for (const active of [false, null]) {
      expect(decide(state({ active, mfa_required: true, scope: null }))).toMatchObject({
        allowed: false,
        code: 'FORBIDDEN',
        reason: 'ACCESS_INELIGIBLE',
        severity: 'HIGH',
        audit: true,
      });
    }
  });

  it('requires a step-up before answering whether the permission is held', () => {
    expect(decide(state({ mfa_required: true, aal: 'aal1', scope: null }))).toMatchObject({
      allowed: false,
      code: 'STEP_UP_REQUIRED',
      assurance: { required: 'aal2', current: 'aal1' },
    });
  });

  it('treats an unknown MFA requirement or an unknown assurance value as not good enough', () => {
    expect(decide(state({ mfa_required: null, aal: 'aal2' }))).toMatchObject({ allowed: true });
    expect(decide(state({ mfa_required: null, aal: 'aal1' }))).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(decide(state({ mfa_required: true, aal: 'aal3' }))).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  it('refuses a missing or unrecognised scope as no permission', () => {
    for (const scope of [null, '', 'WIDE']) {
      expect(decide(state({ scope }))).toMatchObject({
        code: 'FORBIDDEN',
        reason: 'PERMISSION_DENIED',
      });
    }
  });

  it('refuses an insufficient or unknown breadth only when a minimum was asked for', () => {
    expect(decide(state({ scope: 'DEPARTMENT', scope_sufficient: false }), 'GLOBAL')).toMatchObject(
      {
        code: 'SCOPE_DENIED',
        metadata: { effective_scope: 'DEPARTMENT', required_scope: 'GLOBAL' },
      },
    );
    expect(decide(state({ scope_sufficient: null }), 'SELF')).toMatchObject({
      code: 'SCOPE_DENIED',
    });
    expect(decide(state({ scope_sufficient: false }))).toMatchObject({ allowed: true });
  });

  it('allows with the scope and the verified assurance', () => {
    expect(decide(state({ scope: 'GLOBAL', aal: 'aal2', mfa_required: true }))).toEqual({
      allowed: true,
      scope: 'GLOBAL',
      aal: 'aal2',
    });
  });
});

// ── requirePermission() around the decision ──────────────────────────────────────

describe('requirePermission() — flow', () => {
  const ask = (request: Parameters<typeof requirePermission>[1], headers = new Headers()) =>
    requirePermission(headers, request);

  it('rejects a malformed request as a programming error, before any lookup', async () => {
    for (const request of [
      { permission: 'People.View' },
      { permission: 'people' },
      { permission: 'people.view', minScope: 'EVERYTHING' },
      { permission: 'people.view', target: { entity: 'lead', id: TARGET_ID } },
      { permission: 'people.view', target: { entity: 'person', id: 42 } },
    ]) {
      await expect(ask(request as never)).rejects.toBeInstanceOf(TypeError);
    }
    expect(mocks.resolveAuthContext).not.toHaveBeenCalled();
  });

  it('refuses no identity with 401, touching neither the database nor the audit log', async () => {
    mocks.resolveAuthContext.mockResolvedValue(null);
    await expect(ask({ permission: 'people.view' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(mocks.withAuthorizedDb).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses an identity the database no longer accepts with 401 and no audit entry', async () => {
    dbAnswers(state({ person_id: null }));
    await expect(ask({ permission: 'people.view' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('records every other refusal once, as a DENIED entry naming the permission', async () => {
    dbAnswers(state({ scope: null }));
    const error = await ask({ permission: 'leads.view' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(mocks.writeAuditEntry).toHaveBeenCalledTimes(1);
    const [ctx, entry, meta] = mocks.writeAuditEntry.mock.calls[0]!;
    expect(ctx).toEqual(CTX);
    expect(entry).toEqual({
      action: 'leads.view',
      entityType: 'permission',
      entityId: null,
      result: 'DENIED',
      severity: 'MEDIUM',
      metadata: { reason: 'PERMISSION_DENIED' },
    });
    expect(meta.requestId).toBe((error as { requestId: string }).requestId);
  });

  it('still refuses, with the same answer, when the audit write itself fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      dbAnswers(state({ active: false }));
      mocks.writeAuditEntry.mockRejectedValue(
        Object.assign(new Error('Failed query ... params: secret'), { code: '08006' }),
      );
      const error = await ask({ permission: 'people.view' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error).toMatchObject({ code: 'FORBIDDEN' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  });

  it('conceals a malformed target id as NOT_FOUND without asking the database about it', async () => {
    dbAnswers(state());
    await expect(
      ask({ permission: 'people.view', target: { entity: 'person', id: "1' or '1'='1" } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEntry.mock.calls[0]![1]).toMatchObject({
      entityType: 'person',
      entityId: null,
      metadata: { reason: 'TARGET_NOT_VISIBLE' },
    });
  });

  it('conceals an invisible target as NOT_FOUND and records the id that was tried', async () => {
    dbAnswers(state(), { visible: false });
    await expect(
      ask({ permission: 'people.view', target: { entity: 'person', id: TARGET_ID.toUpperCase() } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.writeAuditEntry.mock.calls[0]![1]).toMatchObject({
      entityType: 'person',
      entityId: TARGET_ID,
      severity: 'LOW',
    });
  });

  it('never probes the target when an earlier step has already refused', async () => {
    dbAnswers(state({ scope: null }));
    await expect(
      ask({ permission: 'people.view', target: { entity: 'person', id: TARGET_ID } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('returns a frozen Authorization that only it can issue', async () => {
    dbAnswers(state({ scope: 'DEPARTMENT' }), { visible: true });
    const authorization = await ask({
      permission: 'people.view',
      target: { entity: 'person', id: TARGET_ID },
    });
    expect(authorization).toMatchObject({
      permission: 'people.view',
      scope: 'DEPARTMENT',
      aal: 'aal1',
      target: { entity: 'person', id: TARGET_ID },
    });
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.ctx)).toBe(true);
    expect(isAuthorization(authorization)).toBe(true);

    const forged = { ...authorization };
    expect(isAuthorization(forged)).toBe(false);
    expect(() => assertAuthorization(forged)).toThrow(TypeError);
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('keeps a supplied uuid request id and replaces anything else', async () => {
    dbAnswers(state(), state());
    const rid = '66666666-6666-4666-8666-666666666666';
    expect((await ask({ permission: 'people.view', requestId: rid })).requestId).toBe(rid);
    const replaced = await ask({ permission: 'people.view', requestId: 'not-a-uuid' });
    expect(replaced.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('conceals a write that touched nothing, and refuses a forged Authorization outright', async () => {
    dbAnswers(state());
    const authorization = await ask({ permission: 'people.edit' });
    await expect(assertTargetAffected(authorization, 1)).resolves.toBeUndefined();
    await expect(assertTargetAffected(authorization, 0)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(assertTargetAffected({ ...authorization }, 1)).rejects.toBeInstanceOf(TypeError);
  });
});

// ── the HTTP wrapper ─────────────────────────────────────────────────────────────

describe('withPermission()', () => {
  const handler = vi.fn(async (_req: Request, authorization: unknown, params: unknown) =>
    Response.json({ ok: isAuthorization(authorization), params }),
  );
  const route = withPermission(
    {
      permission: 'people.view',
      target: (params: { id?: string }) => ({ entity: 'person', id: params.id! }),
    },
    handler,
  );
  const call = (init: RequestInit = {}, params: Record<string, string> = { id: TARGET_ID }) =>
    route(new Request('https://os.pravshi.com/api/x', init), { params: Promise.resolve(params) });

  beforeEach(() => handler.mockClear());

  it('refuses a cross-origin state-changing request before resolving anyone', async () => {
    const res = await call({ method: 'POST', headers: { origin: 'https://evil.test' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(mocks.resolveAuthContext).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 401 as an uncacheable envelope and never runs the handler', async () => {
    mocks.resolveAuthContext.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers a step-up with the assurance the interface needs', async () => {
    dbAnswers(state({ mfa_required: true }));
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      assurance: { required: 'aal2', current: 'aal1' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler only with a real Authorization and the route params', async () => {
    dbAnswers(state(), { visible: true });
    const res = await call({ method: 'POST', headers: { origin: 'https://os.pravshi.com' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, params: { id: TARGET_ID } });
  });

  it('maps an AuthorizationError thrown by the handler, and masks anything else', async () => {
    dbAnswers(state(), { visible: true });
    handler.mockImplementationOnce(async () => {
      throw new AuthorizationError('NOT_FOUND', { requestId: 'r', reason: 'TARGET_NOT_VISIBLE' });
    });
    expect((await call()).status).toBe(404);

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      dbAnswers(state(), { visible: true });
      handler.mockImplementationOnce(async () => {
        throw new Error('database said: password=hunter2');
      });
      const res = await call();
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain('hunter2');
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'INTERNAL' } });
      expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    } finally {
      log.mockRestore();
    }
  });

  it('fails a broken target mapping as 500 before resolving anyone', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const broken = withPermission(
        {
          permission: 'people.view',
          target: () => {
            throw new Error('no id');
          },
        },
        handler,
      );
      const res = await broken(new Request('https://os.pravshi.com/api/x'), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(500);
      expect(mocks.resolveAuthContext).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe('actionError()', () => {
  it('returns an authorization refusal as its envelope', () => {
    expect(
      actionError(
        new AuthorizationError('SCOPE_DENIED', { requestId: 'r', reason: 'SCOPE_DENIED' }),
      ),
    ).toMatchObject({ error: { code: 'SCOPE_DENIED', requestId: 'r' } });
  });

  it('returns anything else as an internal error with no detail', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const envelope = actionError(new Error('token=abc'));
      expect(envelope.error.code).toBe('INTERNAL');
      expect(JSON.stringify(envelope)).not.toContain('abc');
    } finally {
      log.mockRestore();
    }
  });
});
