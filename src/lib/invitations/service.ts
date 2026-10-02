import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import { sqlstateOf } from '@/lib/auth/invitations';
import { generateInvitationToken, hashInvitationToken } from './tokens';
import type { CreateInvitationInput } from './schema';

/**
 * Invitation service — the authorised half. Business logic and data access; the only
 * place SQL lives for invitation management.
 *
 *   authorised half  (create, revoke) — takes the Authorization that only
 *                      requirePermission() can issue, works through withAuthorizedDb().
 *   pre-auth half     (preview, accept) — lives in src/lib/auth/invitations.ts, the
 *                      auth module, because the invitee has no session yet and it must
 *                      reach the database through authDb (the sanctioned exception).
 */

export class InvitationError extends Error {
  constructor(
    readonly code:
      | 'EMAIL_HAS_LOGIN'
      | 'INVITATION_ALREADY_LIVE'
      | 'PERSON_NOT_FOUND'
      | 'PERSON_NOT_INVITABLE'
      | 'PERSON_EMAIL_MISMATCH'
      | 'ENGAGEMENT_REQUIRED'
      | 'DEPARTMENT_NOT_FOUND'
      | 'ROLE_NOT_FOUND'
      | 'ROLE_PROTECTED'
      | 'INVITATION_NOT_FOUND'
      | 'INVITATION_INVALID'
      | 'INVITATION_ALREADY_ACCEPTED'
      | 'INVITATION_CANNOT_COMPLETE'
      | 'PASSWORD_TOO_SHORT'
      | 'PASSWORD_TOO_LONG',
    message: string,
  ) {
    super(message);
    this.name = 'InvitationError';
  }
}

export interface CreatedInvitation {
  id: string;
  code: string;
  email: string;
  expiresAt: Date;
  /** The plaintext token. Returned exactly once, to the admin who created it. */
  token: string;
  inviterName: string;
  orgName: string;
}

async function resolveRoleIds(tx: Tx, orgId: string, roleIds: string[]): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from public.roles
    where org_id = ${orgId}::uuid
      and id = any(${roleIds}::uuid[])
      and deleted_at is null
      and status = 'ACTIVE'
  `);
  if (rows.rows.length !== roleIds.length) {
    throw new InvitationError('ROLE_NOT_FOUND', 'One or more roles do not exist or are archived.');
  }

  // A protected role in the invitation requires roles.manage at GLOBAL — checked
  // against the inviter's LIVE permission, so an invitation that the acceptance
  // trigger would refuse can never be issued in the first place.
  try {
    await tx.execute(sql`
      select public.invitation_grant_check(${roleIds}::uuid[])
    `);
  } catch (e) {
    // drizzle wraps the driver error in DrizzleQueryError, so the SQLSTATE
    // may live on `e.cause` — sqlstateOf checks both.
    if (sqlstateOf(e) === '42501') {
      throw new InvitationError(
        'ROLE_PROTECTED',
        'Inviting with an administrative role requires roles.manage at global scope.',
      );
    }
    throw e;
  }
}

/**
 * Create an invitation. The caller was authorized for users.create before this runs;
 * the RLS WITH CHECK policy re-verifies that at the database.
 */
export async function createInvitation(
  authorization: Authorization,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const { ctx } = authorization;

  return withAuthorizedDb(ctx, async (tx) => {
    await resolveRoleIds(tx, ctx.orgId, input.roleIds);

    if (input.personId) {
      const person = await tx.execute<{
        person_status: string;
        auth_user_id: string | null;
        work_email: string;
      }>(sql`
        select person_status, auth_user_id, work_email from public.people
        where id = ${input.personId}::uuid and org_id = ${ctx.orgId}::uuid
      `);
      const row = person.rows[0];
      if (!row) throw new InvitationError('PERSON_NOT_FOUND', 'The linked person does not exist.');
      if (row.person_status !== 'ACTIVE' || row.auth_user_id !== null) {
        throw new InvitationError(
          'PERSON_NOT_INVITABLE',
          'Only an active person without a login can be invited.',
        );
      }
      // The invitation email becomes the login email; it must be the person's work
      // email, or login-time email resolution (resolve_login_org) and the person's
      // own address would disagree about who this account belongs to.
      if (row.work_email.toLowerCase() !== input.email.toLowerCase()) {
        throw new InvitationError(
          'PERSON_EMAIL_MISMATCH',
          'The invitation email must match the linked person\u2019s work email.',
        );
      }
    }

    // Nobody gets two live invitations: the first token still works, and two live
    // tokens for one email is how someone accepts the wrong one.
    const live = await tx.execute<{ id: string }>(sql`
      select id from public.invitations
      where org_id = ${ctx.orgId}::uuid
        and email = ${input.email}::public.citext
        and expires_at > now() and accepted_at is null and revoked_at is null
      limit 1
    `);
    if (live.rows[0]) {
      throw new InvitationError(
        'INVITATION_ALREADY_LIVE',
        'A live invitation already exists for this email. Revoke it first to re-issue.',
      );
    }

    // A login already exists for this email in this org — inviting would create a
    // second person for one human.
    const existing = await tx.execute<{ id: string }>(sql`
      select p.id from public.people p
      where p.org_id = ${ctx.orgId}::uuid
        and p.work_email = ${input.email}::public.citext
        and p.auth_user_id is not null and p.deleted_at is null
      limit 1
    `);
    if (existing.rows[0]) {
      throw new InvitationError('EMAIL_HAS_LOGIN', 'This email already has a login.');
    }

    // Engagement terms. The acceptance creates an engagement when the invitee has
    // no live one — without it the new login authenticates but sees nothing. A
    // brand-new person never has one, so the terms are required; a linked person
    // is checked, and the terms are required only when they lack one.
    let needsEngagement = !input.personId;
    if (input.personId) {
      const eng = await tx.execute<{ id: string }>(sql`
        select e.id from public.engagements e
        where e.person_id = ${input.personId}::uuid
          and e.org_id = ${ctx.orgId}::uuid
          and e.status in ('PRE_ONBOARDING', 'ONBOARDING', 'ACTIVE', 'NOTICE_PERIOD')
          and e.is_primary and e.deleted_at is null
        limit 1
      `);
      needsEngagement = !eng.rows[0];
    }
    const engagementType = input.engagementType ?? null;
    const departmentId = input.departmentId ?? null;
    const startDate = input.startDate ?? null;
    if (needsEngagement && (!engagementType || !departmentId || !startDate)) {
      throw new InvitationError(
        'ENGAGEMENT_REQUIRED',
        'This invitee has no engagement: choose an engagement type, department and start date.',
      );
    }
    if (departmentId) {
      const dept = await tx.execute<{ id: string }>(sql`
        select d.id from public.departments d
        where d.id = ${departmentId}::uuid
          and d.org_id = ${ctx.orgId}::uuid
          and d.deleted_at is null
        limit 1
      `);
      if (!dept.rows[0]) {
        throw new InvitationError('DEPARTMENT_NOT_FOUND', 'The chosen department does not exist.');
      }
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);

    const codeRow = await tx.execute<{ code: string }>(sql`
      select authz.next_identity_code(
        ${ctx.orgId}::uuid, 'INV',
        to_char(now() at time zone o.timezone, 'YYYY')
      ) as code
      from public.organizations o where o.id = ${ctx.orgId}::uuid
    `);
    const code = codeRow.rows[0]?.code;
    if (!code)
      throw new InvitationError(
        'INVITATION_CANNOT_COMPLETE',
        'Could not issue an invitation code.',
      );

    const inserted = await tx.execute<{ id: string; expires_at: Date }>(sql`
      insert into public.invitations
        (org_id, code, email, token_hash, person_id, invited_by, expires_at,
         engagement_type, department_id, start_date)
      values
        (${ctx.orgId}::uuid, ${code}, ${input.email}::public.citext, ${tokenHash},
         ${input.personId ?? null}::uuid, ${ctx.personId}::uuid,
         now() + make_interval(days => ${input.expiresInDays}),
         ${engagementType}::public.engagement_type, ${departmentId}::uuid,
         ${startDate}::date)
      returning id, expires_at
    `);
    const invitationId = inserted.rows[0]?.id;
    const expiresAt = inserted.rows[0]?.expires_at;
    if (!invitationId || !expiresAt) {
      throw new InvitationError('INVITATION_CANNOT_COMPLETE', 'Could not create the invitation.');
    }

    for (const roleId of input.roleIds) {
      await tx.execute(sql`
        insert into public.invitation_roles (invitation_id, role_id, org_id)
        values (${invitationId}::uuid, ${roleId}::uuid, ${ctx.orgId}::uuid)
      `);
    }

    // Audit the issuance in the same transaction: accept and revoke already write
    // their events, and an issuance with no audit entry would leave a gap between
    // them. Same-transaction (not the audit module's own-transaction writer) so a
    // rolled-back invitation cannot leave a phantom "created" entry behind.
    await tx.execute(sql`
      select public.write_audit_log(
        p_action := 'invitation.create',
        p_entity_type := 'invitation',
        p_result := 'SUCCESS',
        p_entity_id := ${invitationId}::uuid,
        p_severity := 'MEDIUM',
        p_metadata := ${JSON.stringify({
          email: input.email,
          role_count: input.roleIds.length,
          person_id: input.personId ?? null,
          expires_in_days: input.expiresInDays,
          engagement_type: engagementType,
          department_id: departmentId,
          start_date: startDate,
        })}::jsonb
      )
    `);

    const meta = await tx.execute<{ inviter_name: string; org_name: string }>(sql`
      select
        (select p.full_legal_name from public.people p where p.id = ${ctx.personId}::uuid) as inviter_name,
        (select o.name from public.organizations o where o.id = ${ctx.orgId}::uuid) as org_name
    `);

    return {
      id: invitationId,
      code,
      email: input.email,
      expiresAt: new Date(expiresAt),
      token,
      inviterName: meta.rows[0]?.inviter_name ?? 'A Pravshi OS administrator',
      orgName: meta.rows[0]?.org_name ?? 'Pravshi OS',
    };
  });
}

/** Revoke an invitation that has not been accepted yet. Idempotent. */
export async function revokeInvitation(authorization: Authorization, id: string): Promise<void> {
  try {
    await withAuthorizedDb(authorization.ctx, async (tx) => {
      await tx.execute(sql`select public.revoke_invitation(${id}::uuid)`);
    });
  } catch (e) {
    throw mapRevokeError(e);
  }
}

function mapRevokeError(e: unknown): InvitationError {
  const code = sqlstateOf(e);
  if (code === '02000') return new InvitationError('INVITATION_NOT_FOUND', 'Invitation not found.');
  if (code === '42501')
    return new InvitationError('INVITATION_INVALID', 'Not permitted to revoke invitations.');
  if (code === '23514') {
    return new InvitationError(
      'INVITATION_ALREADY_ACCEPTED',
      'This invitation was already accepted. Suspend the login instead.',
    );
  }
  throw e instanceof Error ? e : new Error(String(e));
}
