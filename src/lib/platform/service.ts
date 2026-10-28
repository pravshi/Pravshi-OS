import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashSetupToken, sqlstateOf } from '@/lib/auth/bootstrap-setup';
import { withPlatformTx } from '@/lib/db/platform-pool';
import type { Tx } from '@/lib/db/authorized';
import {
  recordPlatformFailure,
  type PlatformOperation,
  type PlatformPermission,
  type PlatformRequest,
} from './guard';

/**
 * The platform console's operations (ADR-008). Each is one app_platform transaction calling
 * one SECURITY DEFINER function, which re-derives the administrator, re-checks aal2, the
 * factor and the permission, does the work and writes its SUCCESS audit entry in the same
 * transaction. A refusal or failure rolls all of that back; the wrapper then writes the
 * DENIED / ERROR entry in a transaction of its own (platform.record_failure).
 *
 * Setup tokens are generated here, 32 bytes from the CSPRNG, and only their SHA-256 digest
 * reaches the database. The token itself is returned to the caller once and never stored,
 * logged or audited.
 */
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** A fixed, user-presentable message; never a driver message. */
    readonly userMessage: string,
  ) {
    super(code);
    this.name = 'PlatformError';
  }
}

/** The answer for each SQLSTATE the platform functions raise, per operation. */
type Refusals = Partial<Record<string, { status: number; code: string; message: string }>>;

const COMMON: Refusals = {
  '42501': { status: 403, code: 'FORBIDDEN', message: 'You are not allowed to do this.' },
  P0002: { status: 404, code: 'NOT_FOUND', message: 'It no longer exists.' },
};

const NOT_AN_ACTOR = {
  status: 403,
  code: 'MFA_REQUIRED',
  message: 'Your session no longer qualifies (second factor or session). Sign in again.',
};

/**
 * 42501 means several things: the actor is no longer accepted (factor removed, session past a
 * limit), the permission is gone, or — for some operations — a business rule (an administrator
 * cannot revoke themselves). An operation's own 42501 answer is used only after a fresh check
 * shows the actor is still accepted and still holds `permission` (review F-CONSOLE-3).
 */
async function classify42501(
  req: PlatformRequest,
  refusals: Refusals,
  permission: PlatformPermission | undefined,
) {
  try {
    const held = await withPlatformTx(req.settings, (tx) =>
      tx.execute<{ permissions: string[] }>(sql`select permissions from platform.whoami()`),
    );
    const permissions = held.rows[0]?.permissions ?? [];
    if (permission && !permissions.includes(permission)) return COMMON['42501']!;
    return refusals['42501'] ?? COMMON['42501']!;
  } catch {
    return NOT_AN_ACTOR;
  }
}

export async function runPlatformOperation<T>(
  req: PlatformRequest,
  operation: PlatformOperation,
  refusals: Refusals,
  fn: (tx: Tx) => Promise<T>,
  opts: { targetOrgId?: string; permission?: PlatformPermission } = {},
): Promise<T> {
  const targetOrgId = opts.targetOrgId ?? null;
  try {
    return await withPlatformTx(req.settings, fn);
  } catch (e) {
    const sqlstate = sqlstateOf(e);
    const known =
      sqlstate === '42501'
        ? await classify42501(req, refusals, opts.permission)
        : (sqlstate && (refusals[sqlstate] ?? COMMON[sqlstate])) || null;
    await recordPlatformFailure(
      req.actor,
      operation,
      sqlstate === '42501' ? 'DENIED' : 'ERROR',
      known ? known.code : 'UNEXPECTED',
      req.requestId,
      targetOrgId,
    );
    if (known) throw new PlatformError(known.status, known.code, known.message);
    console.error('[platform] operation failed', { operation, sqlstate });
    throw new PlatformError(500, 'INTERNAL', 'Something went wrong. Nothing was changed.');
  }
}

export const newSetupToken = (): string => randomBytes(32).toString('base64url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

// ── identity ─────────────────────────────────────────────────────────────────

export interface WhoAmI {
  adminId: string;
  email: string;
  fullName: string;
  permissions: string[];
}

export async function whoami(req: PlatformRequest): Promise<WhoAmI> {
  let rows;
  try {
    rows = await withPlatformTx(req.settings, (tx) =>
      tx.execute<{ admin_id: string; email: string; full_name: string; permissions: string[] }>(
        sql`select admin_id, email::text as email, full_name, permissions from platform.whoami()`,
      ),
    );
  } catch (e) {
    // whoami() refuses only a caller the database no longer accepts as an actor.
    if (sqlstateOf(e) === '42501') {
      throw new PlatformError(NOT_AN_ACTOR.status, NOT_AN_ACTOR.code, NOT_AN_ACTOR.message);
    }
    throw e;
  }
  const r = rows.rows[0];
  if (!r) throw new PlatformError(NOT_AN_ACTOR.status, NOT_AN_ACTOR.code, NOT_AN_ACTOR.message);
  return { adminId: r.admin_id, email: r.email, fullName: r.full_name, permissions: r.permissions };
}

// ── organizations ────────────────────────────────────────────────────────────

export interface OrganizationRow {
  orgId: string;
  name: string;
  slug: string;
  typeKey: string;
  templateVersion: number;
  status: string;
  timezone: string;
  createdAt: string;
  suspendedAt: string | null;
  activeMembers: number;
  firstAdminSetupPending: boolean;
}

export async function listOrganizations(req: PlatformRequest): Promise<OrganizationRow[]> {
  const rows = await runPlatformOperation(req, 'platform.organization.list', {}, (tx) =>
    tx.execute<{
      org_id: string;
      name: string;
      slug: string;
      type_key: string;
      template_version: number;
      status: string;
      timezone: string;
      created_at: Date | string;
      suspended_at: Date | string | null;
      active_members: number;
      first_admin_setup_pending: boolean;
    }>(sql`select * from platform.list_organizations()`),
  );
  return rows.rows.map((r) => ({
    orgId: r.org_id,
    name: r.name,
    slug: r.slug,
    typeKey: r.type_key,
    templateVersion: r.template_version,
    status: r.status,
    timezone: r.timezone,
    createdAt: new Date(r.created_at).toISOString(),
    suspendedAt: r.suspended_at ? new Date(r.suspended_at).toISOString() : null,
    activeMembers: r.active_members,
    firstAdminSetupPending: r.first_admin_setup_pending,
  }));
}

export interface OrganizationTypeRow {
  typeKey: string;
  displayName: string;
  description: string | null;
  latestVersion: number;
}

export async function listOrganizationTypes(req: PlatformRequest): Promise<OrganizationTypeRow[]> {
  const rows = await runPlatformOperation(req, 'platform.organization.list', {}, (tx) =>
    tx.execute<{
      type_key: string;
      display_name: string;
      description: string | null;
      latest_version: number;
    }>(sql`select * from platform.list_organization_types()`),
  );
  return rows.rows.map((r) => ({
    typeKey: r.type_key,
    displayName: r.display_name,
    description: r.description,
    latestVersion: r.latest_version,
  }));
}

export interface ProvisionInput {
  idempotencyKey: string;
  name: string;
  slug: string;
  timezone: string;
  typeKey: string;
  adminFullName: string;
  adminEmail: string;
}

export type ProvisionResult =
  | { replayed: false; orgId: string; setupToken: string; setupExpiresAt: string }
  /** The same request was already completed: its setup link is not shown again (re-issue it). */
  | { replayed: true; orgId: string };

const PROVISION_REFUSALS: Refusals = {
  '22023': { status: 400, code: 'INVALID_INPUT', message: 'Check the highlighted fields.' },
  '55000': {
    status: 409,
    code: 'EMAIL_IN_USE',
    message: 'That email already belongs to a login or a person.',
  },
  '23505': {
    status: 409,
    code: 'CONFLICT',
    message: 'That slug is taken, or this request was already sent with different details.',
  },
};

export async function provisionOrganization(
  req: PlatformRequest,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const token = newSetupToken();
  const digest = hashSetupToken(token);
  const rows = await runPlatformOperation(
    req,
    'platform.organization.provision',
    PROVISION_REFUSALS,
    (tx) =>
      tx.execute<{
        provisioned_org_id: string;
        setup_expires_at: Date | string | null;
        replayed: boolean;
      }>(sql`
      select provisioned_org_id, setup_expires_at, replayed
      from platform.provision_organization(
        ${input.idempotencyKey}, ${input.name}, ${input.slug}, ${input.timezone}, ${input.typeKey},
        ${input.adminFullName}, ${input.adminEmail}, decode(${digest}, 'hex'), ${req.requestId}::uuid)
    `),
  );
  const r = rows.rows[0];
  if (!r) throw new PlatformError(500, 'INTERNAL', 'Something went wrong. Nothing was changed.');
  if (r.replayed || !r.setup_expires_at) return { replayed: true, orgId: r.provisioned_org_id };
  return {
    replayed: false,
    orgId: r.provisioned_org_id,
    setupToken: token,
    setupExpiresAt: new Date(r.setup_expires_at).toISOString(),
  };
}

export async function reissueOrgAdminSetup(
  req: PlatformRequest,
  orgId: string,
): Promise<{
  setupToken: string;
  setupExpiresAt: string;
  recipient: { email: string; fullName: string; orgName: string };
}> {
  const token = newSetupToken();
  const digest = hashSetupToken(token);
  const rows = await runPlatformOperation(
    req,
    'platform.organization.admin_setup_reissue',
    {
      '55000': {
        status: 409,
        code: 'CANNOT_REISSUE',
        message:
          'The organization is not active, or its first administrator already completed setup.',
      },
    },
    // One transaction: the new hash commits only together with the address the new link is
    // sent to — a failed lookup leaves the old link in place and nothing changed.
    async (tx) => {
      const issued = await tx.execute<{ expires_at: Date | string }>(sql`
        select platform.reissue_org_admin_setup(${orgId}::uuid, decode(${digest}, 'hex'),
                                                ${req.requestId}::uuid) as expires_at
      `);
      const to = await tx.execute<{ email: string; full_name: string; org_name: string }>(
        sql`select email, full_name, org_name from platform.org_admin_setup_recipient(${orgId}::uuid)`,
      );
      // No pending recipient: refused like any other "cannot re-issue" (55000), rolled back.
      if (!to.rows[0]) throw Object.assign(new Error('no pending recipient'), { code: '55000' });
      return { expires: issued.rows[0]?.expires_at, to: to.rows[0] };
    },
    { targetOrgId: orgId, permission: 'platform.organizations.assign_initial_admin' },
  );
  if (!rows.expires)
    throw new PlatformError(500, 'INTERNAL', 'Something went wrong. Nothing was changed.');
  return {
    setupToken: token,
    setupExpiresAt: new Date(rows.expires).toISOString(),
    recipient: {
      email: rows.to.email,
      fullName: rows.to.full_name,
      orgName: rows.to.org_name,
    },
  };
}

export async function setOrganizationStatus(
  req: PlatformRequest,
  orgId: string,
  to: 'SUSPENDED' | 'ACTIVE',
  reason: string,
): Promise<'SUSPENDED' | 'ACTIVE' | 'UNCHANGED'> {
  const rows = await runPlatformOperation(
    req,
    to === 'SUSPENDED' ? 'platform.organization.suspend' : 'platform.organization.reactivate',
    {
      '22023': {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'A reason of 3-500 characters is required.',
      },
      '55000': {
        status: 409,
        code: 'ARCHIVED',
        message: 'An archived organization cannot change state.',
      },
    },
    (tx) =>
      tx.execute<{ result: 'SUSPENDED' | 'ACTIVE' | 'UNCHANGED' }>(sql`
        select platform.set_organization_status(${orgId}::uuid, ${to}, ${reason},
                                                ${req.requestId}::uuid) as result
      `),
    {
      targetOrgId: orgId,
      permission:
        to === 'SUSPENDED' ? 'platform.organizations.suspend' : 'platform.organizations.reactivate',
    },
  );
  return rows.rows[0]?.result ?? 'UNCHANGED';
}

// ── administrators ───────────────────────────────────────────────────────────

export interface AdminRow {
  adminId: string;
  email: string;
  fullName: string;
  status: string;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  hasLogin: boolean;
  permissions: string[];
}

export async function listAdmins(req: PlatformRequest): Promise<AdminRow[]> {
  const rows = await runPlatformOperation(req, 'platform.admin.list', {}, (tx) =>
    tx.execute<{
      admin_id: string;
      email: string;
      full_name: string;
      status: string;
      created_at: Date | string;
      created_by: string | null;
      revoked_at: Date | string | null;
      has_login: boolean;
      permissions: string[];
    }>(sql`
      select admin_id, email::text as email, full_name, status, created_at, created_by,
             revoked_at, has_login, permissions
      from platform.list_admins()
    `),
  );
  return rows.rows.map((r) => ({
    adminId: r.admin_id,
    email: r.email,
    fullName: r.full_name,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy: r.created_by,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    hasLogin: r.has_login,
    permissions: r.permissions,
  }));
}

export type InviteResult =
  | { replayed: false; adminId: string; setupToken: string; setupExpiresAt: string }
  /** The same request was already completed: its link is not shown again (re-issue it). */
  | { replayed: true; adminId: string };

/**
 * Idempotent by key (F-CONSOLE-11): a retry after a lost response answers the first result and
 * creates nothing; the same key with other details is refused (409).
 */
export async function inviteAdmin(
  req: PlatformRequest,
  input: { idempotencyKey: string; email: string; fullName: string; permissions: string[] },
): Promise<InviteResult> {
  const token = newSetupToken();
  const digest = hashSetupToken(token);
  // One bound parameter per key, as an array constructor: drizzle expands a JS array into a
  // parenthesised list, which is not an array literal.
  const permissions =
    input.permissions.length === 0
      ? sql`'{}'::text[]`
      : sql`array[${sql.join(
          input.permissions.map((p) => sql`${p}`),
          sql`, `,
        )}]::text[]`;
  const rows = await runPlatformOperation(
    req,
    'platform.admin.invite',
    {
      '22023': {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Check the name, email and permissions.',
      },
      '55000': {
        status: 409,
        code: 'EMAIL_IN_USE',
        message: 'That email already has a login or is already a platform administrator.',
      },
      '23505': {
        status: 409,
        code: 'CONFLICT',
        message: 'This invitation was already sent with different details.',
      },
      '42501': {
        status: 403,
        code: 'FORBIDDEN',
        message: 'You can grant only permissions you hold yourself.',
      },
    },
    (tx) =>
      tx.execute<{
        invited_admin_id: string;
        setup_expires_at: Date | string | null;
        replayed: boolean;
      }>(sql`
        select invited_admin_id, setup_expires_at, replayed
        from platform.invite_admin_once(${input.idempotencyKey}, ${input.email},
                                        ${input.fullName}, ${permissions},
                                        decode(${digest}, 'hex'), ${req.requestId}::uuid)
      `),
    { permission: 'platform.admins.manage' },
  );
  const r = rows.rows[0];
  if (!r) throw new PlatformError(500, 'INTERNAL', 'Something went wrong. Nothing was changed.');
  if (r.replayed || !r.setup_expires_at) return { replayed: true, adminId: r.invited_admin_id };
  return {
    replayed: false,
    adminId: r.invited_admin_id,
    setupToken: token,
    setupExpiresAt: new Date(r.setup_expires_at).toISOString(),
  };
}

/**
 * A new 72-hour link for an invited administrator who never set up a login; the old link stops
 * working and the recipient stays the invitation's. One who has a login is the operator's.
 */
export async function reissueAdminSetup(
  req: PlatformRequest,
  adminId: string,
): Promise<{
  setupToken: string;
  setupExpiresAt: string;
  recipient: { email: string; fullName: string };
}> {
  const token = newSetupToken();
  const digest = hashSetupToken(token);
  const rows = await runPlatformOperation(
    req,
    'platform.admin.setup_reissue',
    {
      '55000': {
        status: 409,
        code: 'CANNOT_REISSUE',
        message:
          'Only an invitation that was never used can be re-issued here. An administrator who ' +
          'already set up a login is recovered by the operator.',
      },
      '42501': {
        status: 403,
        code: 'FORBIDDEN',
        message:
          'Only the administrator who sent this invitation, still holding every permission it ' +
          'grants, can re-issue it. Otherwise ask the operator.',
      },
    },
    // One transaction: the new hash commits only together with the address it is sent to —
    // the invited administrator's own, recorded at invitation and never changed (0083).
    async (tx) => {
      const issued = await tx.execute<{ expires_at: Date | string }>(sql`
        select platform.reissue_admin_setup(${adminId}::uuid, decode(${digest}, 'hex'),
                                            ${req.requestId}::uuid) as expires_at
      `);
      const to = await tx.execute<{ email: string; full_name: string }>(sql`
        select email::text as email, full_name from platform.list_admins()
        where admin_id = ${adminId}::uuid
      `);
      if (!to.rows[0]) throw Object.assign(new Error('no recipient'), { code: '55000' });
      return { expires: issued.rows[0]?.expires_at, to: to.rows[0] };
    },
    { permission: 'platform.admins.manage' },
  );
  if (!rows.expires)
    throw new PlatformError(500, 'INTERNAL', 'Something went wrong. Nothing was changed.');
  return {
    setupToken: token,
    setupExpiresAt: new Date(rows.expires).toISOString(),
    recipient: { email: rows.to.email, fullName: rows.to.full_name },
  };
}

export async function revokeAdmin(
  req: PlatformRequest,
  adminId: string,
  reason: string,
): Promise<void> {
  await runPlatformOperation(
    req,
    'platform.admin.revoke',
    {
      '22023': {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'A reason of 3-500 characters is required.',
      },
      '42501': {
        status: 409,
        code: 'CANNOT_REVOKE',
        message:
          'You cannot revoke yourself, or the last administrator who can manage administrators.',
      },
    },
    (tx) =>
      tx.execute(sql`
        select platform.revoke_admin(${adminId}::uuid, ${reason}, ${req.requestId}::uuid)
      `),
    { permission: 'platform.admins.manage' },
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  occurredAt: string;
  actorType: string;
  actorAdminId: string | null;
  actorEmail: string | null;
  action: string;
  result: string;
  reasonCode: string | null;
  targetOrgId: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: unknown;
}

export async function listAudit(
  req: PlatformRequest,
  cursor: { beforeAt: string; beforeId: string } | null,
  limit: number,
): Promise<{ rows: AuditRow[]; next: { beforeAt: string; beforeId: string } | null }> {
  const rows = await runPlatformOperation(
    req,
    'platform.audit.list',
    { '22023': { status: 400, code: 'INVALID_INPUT', message: 'Invalid page.' } },
    (tx) =>
      tx.execute<{
        id: string;
        occurred_at: Date | string;
        cursor_at: string;
        actor_type: string;
        actor_admin_id: string | null;
        actor_email: string | null;
        action: string;
        result: string;
        reason_code: string | null;
        target_org_id: string | null;
        target_type: string | null;
        target_id: string | null;
        request_id: string | null;
        metadata: unknown;
      }>(sql`
        select id, occurred_at, occurred_at::text as cursor_at, actor_type, actor_admin_id, actor_email::text as actor_email,
               action, result, reason_code, target_org_id, target_type, target_id, request_id,
               metadata
        from platform.list_audit_events(${cursor?.beforeAt ?? null}::timestamptz,
                                        ${cursor?.beforeId ?? null}::uuid, ${limit}::int)
      `),
  );
  const out = rows.rows.map((r) => ({
    id: r.id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    actorType: r.actor_type,
    actorAdminId: r.actor_admin_id,
    actorEmail: r.actor_email,
    action: r.action,
    result: r.result,
    reasonCode: r.reason_code,
    targetOrgId: r.target_org_id,
    targetType: r.target_type,
    targetId: r.target_id,
    requestId: r.request_id,
    metadata: r.metadata,
  }));
  // The cursor carries the database's own text form of the time: microseconds, not the
  // milliseconds of an ISO string, so entries a millisecond apart are never skipped.
  const last = rows.rows[rows.rows.length - 1];
  return {
    rows: out,
    next: out.length === limit && last ? { beforeAt: last.cursor_at, beforeId: last.id } : null,
  };
}
