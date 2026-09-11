import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { resolveAuthContext } from '@/lib/auth/session';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Aal, AuthContext } from '@/lib/db/context';
import {
  requestMetadata,
  writeAuditEntry,
  type AuditSeverity,
  type RequestMetadata,
} from '@/lib/audit/log';
import {
  AuthorizationError,
  type Assurance,
  type AuthorizationCode,
  type DenialReason,
} from './errors';
import { isTargetEntity, probeTarget, type TargetEntity } from './targets';

/**
 * requirePermission() — the application-layer authorization boundary.
 *
 * ── ONE CHAIN, NOT A SECOND MODEL ────────────────────────────────────────────────
 *
 * Every answer below comes from something that already exists. This file orders the questions,
 * turns the answers into one of five outcomes, and records refusals. It decides nothing about
 * what a role, a scope, a membership or a grant means.
 *
 *   1  session                  resolveAuthContext()          who is asking            → 401
 *   2  identity, re-validated   authz.person_id(), org_id()   inside withAuthorizedDb  → 401
 *   3  eligibility              authz.is_active()             engagement + org ACTIVE  → 403
 *   4  assurance                authz.aal() + mandatory MFA   verified aal2            → 403 step-up
 *   5  capability               authz.scope_for(permission)   any live role grants it  → 403
 *   6  breadth                  minScope, by the enum order                            → 403 scope
 *   7  target                   probe under the table's RLS   scope + grants, per policy → 404
 *
 * Steps 1-6 never look at the target, so no 401 or 403 can reveal whether a record exists.
 * Nothing is cached: a role, engagement or session change applies to the very next request.
 *
 * ── MANDATORY MFA ────────────────────────────────────────────────────────────────
 *
 * A person needs a verified aal2 session for every protected request when any live role gives
 * them a sensitive permission (permissions.is_sensitive) at GLOBAL scope. It is decided from the
 * catalogue through authz.scope_for(), so no role name appears anywhere: the seeded SUPER_ADMIN,
 * ADMIN, HR_ADMIN and FINANCE resolve to it on their own, and a custom role carrying the same
 * capability inherits it. It is per person — a second, non-privileged role cannot lower it.
 *
 * ── RECORD GRANTS ────────────────────────────────────────────────────────────────
 *
 * Never evaluated here. A grant reaches a target only through the table's RLS policy (the
 * database.md 4.2 template ORs authz.has_record_grant()), and only after steps 2-6 have passed.
 * So a grant cannot create a missing permission, change the scope this returns, satisfy
 * minScope, or skip eligibility or MFA. Phase 1 table policies do not consult grants yet, so
 * until the 4.2 rollout they reach nothing there — the same fail-closed direction as TEAM and
 * PROJECT, which stay closed until their relationship helpers exist.
 *
 * ── AFTERWARDS ───────────────────────────────────────────────────────────────────
 *
 * The caller's work runs through withAuthorizedDb(authorization.ctx), the same identity, where
 * every policy re-derives person, engagement and scope. A suspension between this check and the
 * work is still enforced there.
 */

export type AccessScope = 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'PROJECT' | 'SELF';

/** Validation only. The ORDER of scopes lives in the database's access_scope enum and nowhere else. */
const ACCESS_SCOPES: ReadonlySet<string> = new Set([
  'GLOBAL',
  'DEPARTMENT',
  'TEAM',
  'PROJECT',
  'SELF',
]);

const PERMISSION_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthorizationTarget {
  readonly entity: TargetEntity;
  readonly id: string;
}

export interface AuthorizationRequest {
  /** A catalogue key, e.g. 'people.view'. */
  readonly permission: string;
  /** A specific record. Its id is untrusted input and is validated here. */
  readonly target?: AuthorizationTarget;
  /** The narrowest scope this operation accepts, for operations whose breadth matters. */
  readonly minScope?: AccessScope;
  /** Correlates audit entries for one request. Generated when absent or not a uuid. */
  readonly requestId?: string;
}

export interface Authorization {
  /** The identity every later withAuthorizedDb() call for this request must use. */
  readonly ctx: Readonly<AuthContext>;
  readonly permission: string;
  /** The broadest scope a live role grants. Record grants never change it. */
  readonly scope: AccessScope;
  /** Database-verified assurance, not the session's claim. */
  readonly aal: Aal;
  readonly target?: AuthorizationTarget;
  readonly requestId: string;
  readonly meta: RequestMetadata;
}

/** The one statement steps 2-6 are answered from. */
export type AuthorizationState = {
  person_id: string | null;
  org_id: string | null;
  active: boolean | null;
  aal: string | null;
  scope: string | null;
  mfa_required: boolean | null;
  scope_sufficient: boolean | null;
};

export type Decision =
  | { readonly allowed: true; readonly scope: AccessScope; readonly aal: Aal }
  | {
      readonly allowed: false;
      readonly code: AuthorizationCode;
      readonly reason: DenialReason;
      readonly severity: AuditSeverity;
      /** An unauthenticated refusal has no actor and no tenant to record against. */
      readonly audit: boolean;
      readonly assurance?: Assurance;
      readonly metadata: Readonly<Record<string, string | null>>;
    };

const issued = new WeakSet<object>();

/** True only for an object requirePermission() itself returned. */
export function isAuthorization(value: unknown): value is Authorization {
  return typeof value === 'object' && value !== null && issued.has(value);
}

export function assertAuthorization(value: unknown): asserts value is Authorization {
  if (!isAuthorization(value)) {
    throw new TypeError('protected work requires an Authorization issued by requirePermission()');
  }
}

/**
 * Steps 2-6, as a pure function of the database's answers. Every branch fails closed: a missing,
 * NULL or unexpected value is a refusal, never a pass.
 */
export function decideAuthorization(
  state: AuthorizationState | undefined,
  ctx: AuthContext,
  minScope: AccessScope | undefined,
): Decision {
  if (
    !state ||
    !state.person_id ||
    !state.org_id ||
    state.person_id !== ctx.personId ||
    state.org_id !== ctx.orgId
  ) {
    return {
      allowed: false,
      code: 'UNAUTHENTICATED',
      reason: 'NO_IDENTITY',
      severity: 'LOW',
      audit: false,
      metadata: {},
    };
  }

  if (state.active !== true) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      reason: 'ACCESS_INELIGIBLE',
      severity: 'HIGH',
      audit: true,
      metadata: {},
    };
  }

  const aal: Aal = state.aal === 'aal2' ? 'aal2' : 'aal1';
  if (state.mfa_required !== false && aal !== 'aal2') {
    return {
      allowed: false,
      code: 'STEP_UP_REQUIRED',
      reason: 'STEP_UP_REQUIRED',
      severity: 'MEDIUM',
      audit: true,
      assurance: { required: 'aal2', current: 'aal1' },
      metadata: { required_aal: 'aal2', current_aal: aal },
    };
  }

  if (!state.scope || !ACCESS_SCOPES.has(state.scope)) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      reason: 'PERMISSION_DENIED',
      severity: 'MEDIUM',
      audit: true,
      metadata: {},
    };
  }
  const scope = state.scope as AccessScope;

  if (minScope !== undefined && state.scope_sufficient !== true) {
    return {
      allowed: false,
      code: 'SCOPE_DENIED',
      reason: 'SCOPE_DENIED',
      severity: 'MEDIUM',
      audit: true,
      metadata: { effective_scope: scope, required_scope: minScope },
    };
  }

  return { allowed: true, scope, aal };
}

/** Programming errors in the caller — never client input, which only ever reaches target.id. */
function assertWellFormed(request: AuthorizationRequest): void {
  if (typeof request?.permission !== 'string' || !PERMISSION_KEY.test(request.permission)) {
    throw new TypeError(
      'requirePermission: permission must be a catalogue key such as people.view',
    );
  }
  if (request.minScope !== undefined && !ACCESS_SCOPES.has(request.minScope)) {
    throw new TypeError('requirePermission: minScope must be an access scope');
  }
  if (
    request.target !== undefined &&
    (!isTargetEntity(request.target?.entity) || typeof request.target?.id !== 'string')
  ) {
    throw new TypeError('requirePermission: target must name a known entity and a string id');
  }
}

function sqlstateOf(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

async function refuse(
  ctx: AuthContext,
  meta: RequestMetadata,
  permission: string,
  target: AuthorizationTarget | undefined,
  denial: Extract<Decision, { allowed: false }>,
): Promise<never> {
  if (denial.audit) {
    try {
      await writeAuditEntry(
        ctx,
        {
          action: permission,
          entityType: target ? target.entity : 'permission',
          entityId: target && UUID.test(target.id) ? target.id.toLowerCase() : null,
          result: 'DENIED',
          severity: denial.severity,
          metadata: { reason: denial.reason, ...denial.metadata },
        },
        meta,
      );
    } catch (error) {
      // The request is refused either way. The driver error itself is not reported: its message
      // can carry query parameters.
      const sqlstate = sqlstateOf(error);
      console.error('[authz] a denial could not be audited', {
        requestId: meta.requestId,
        sqlstate,
      });
      Sentry.captureMessage('authz denial audit write failed', {
        level: 'error',
        tags: { sqlstate: sqlstate ?? 'none' },
      });
    }
  } else {
    console.warn('[authz] unauthenticated request refused', { requestId: meta.requestId });
  }

  throw new AuthorizationError(denial.code, {
    requestId: meta.requestId,
    reason: denial.reason,
    assurance: denial.assurance,
  });
}

const stateQuery = (permission: string, minScope: AccessScope | undefined) => sql`
  select
    authz.person_id()::text as person_id,
    authz.org_id()::text    as org_id,
    authz.is_active()       as active,
    authz.aal()             as aal,
    authz.scope_for(${permission})::text as scope,
    exists (
      select 1
      from public.permissions p
      where p.is_sensitive
        and authz.scope_for(p.key) = 'GLOBAL'
    ) as mfa_required,
    case
      when ${minScope ?? null}::text is null then true
      else authz.scope_for(${permission}) <= ${minScope ?? null}::public.access_scope
    end as scope_sufficient
`;

/**
 * Authorize one request, or throw AuthorizationError. Never returns a falsy value, and the object
 * it returns cannot be forged elsewhere.
 *
 * Route Handlers use withPermission() (./http), which calls this first. Server Actions call it
 * as their first statement with `new Headers(await headers())`.
 */
export async function requirePermission(
  headers: Headers,
  request: AuthorizationRequest,
): Promise<Authorization> {
  assertWellFormed(request);
  const requestId =
    request.requestId && UUID.test(request.requestId)
      ? request.requestId.toLowerCase()
      : randomUUID();
  const meta = requestMetadata(headers, requestId);
  const { permission, target, minScope } = request;

  const ctx = await resolveAuthContext(headers);
  if (!ctx) {
    console.warn('[authz] unauthenticated request refused', { requestId });
    throw new AuthorizationError('UNAUTHENTICATED', { requestId, reason: 'NO_IDENTITY' });
  }

  const outcome = await withAuthorizedDb(ctx, async (tx) => {
    const result = await tx.execute<AuthorizationState>(stateQuery(permission, minScope));
    const decision = decideAuthorization(result.rows[0], ctx, minScope);
    if (!decision.allowed || !target) return { decision, visible: true };
    const visible =
      UUID.test(target.id) && (await probeTarget(target.entity, tx, target.id.toLowerCase()));
    return { decision, visible };
  });

  if (!outcome.decision.allowed) {
    return refuse(ctx, meta, permission, target, outcome.decision);
  }
  if (target && !outcome.visible) {
    return refuse(ctx, meta, permission, target, {
      allowed: false,
      code: 'NOT_FOUND',
      reason: 'TARGET_NOT_VISIBLE',
      severity: 'LOW',
      audit: true,
      metadata: {},
    });
  }

  const authorization: Authorization = Object.freeze({
    ctx: Object.freeze({ ...ctx }),
    permission,
    scope: outcome.decision.scope,
    aal: outcome.decision.aal,
    ...(target
      ? { target: Object.freeze({ entity: target.entity, id: target.id.toLowerCase() }) }
      : {}),
    requestId,
    meta,
  });
  issued.add(authorization);
  return authorization;
}

/**
 * For a write already authorized against a target: RLS decides which rows a write may touch, and
 * a write that touched none is concealed as NOT_FOUND, exactly like an invisible target.
 */
export async function assertTargetAffected(
  authorization: Authorization,
  affectedRows: number,
): Promise<void> {
  assertAuthorization(authorization);
  if (affectedRows > 0) return;
  await refuse(
    authorization.ctx,
    authorization.meta,
    authorization.permission,
    authorization.target,
    {
      allowed: false,
      code: 'NOT_FOUND',
      reason: 'TARGET_NOT_VISIBLE',
      severity: 'LOW',
      audit: true,
      metadata: {},
    },
  );
}
