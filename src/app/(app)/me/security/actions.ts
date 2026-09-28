'use server';

import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { sql } from 'drizzle-orm';
import { auth } from '@/lib/auth/server';
import { requirePermission } from '@/lib/authz/require-permission';
import { changePassword, ChangePasswordError } from '@/lib/auth/change-password';
import { requestMetadata } from '@/lib/audit/log';
import { withAuthorizedDb } from '@/lib/db/authorized';

/**
 * /me/security Server Actions — the user's own credential and history.
 *
 * Every action opens with requirePermission({ permission: 'people.view',
 * minScope: 'SELF' }): the baseline EMPLOYEE role every active engagement
 * receives is self-service only, so this gates on live identity without
 * demanding any administrative permission. The actions then touch only
 * session-derived IDs (never a caller-supplied target), and the history query
 * runs through withAuthorizedDb so the 0026 SELF RLS policy applies.
 */

const HISTORY_PAGE_SIZE = 20;

export interface ChangePasswordResult {
  ok: boolean;
  error?: string;
}

export async function changePasswordAction(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const authz = await requirePermission(await headers(), {
    permission: 'people.view',
    minScope: 'SELF',
  });
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  const authUserId = session?.user?.id;
  const currentToken = session?.session?.token;
  if (!authUserId || !currentToken) throw new Error('Not signed in.');

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return { ok: false, error: 'Invalid request.' };
  }
  if (newPassword.length > 256 || currentPassword.length > 256) {
    return { ok: false, error: 'Invalid request.' };
  }

  try {
    await changePassword({
      ctx: authz.ctx,
      authUserId,
      currentSessionToken: currentToken,
      currentPassword,
      newPassword,
      meta: requestMetadata(h, randomUUID()),
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ChangePasswordError) {
      // Deliberately generic across all failure modes except weak-password
      // guidance: the current-password check must not become a policy oracle.
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

export interface LoginHistoryRow {
  id: string;
  occurredAt: string | Date;
  eventType: string;
  ipAddress: string | null;
  userAgent: string | null;
  email: string | null;
}

export interface LoginHistoryResult {
  rows: LoginHistoryRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** The signed-in user's own login events, newest first, 20 per page. */
export async function getLoginHistoryAction(page: number): Promise<LoginHistoryResult> {
  const authz = await requirePermission(await headers(), {
    permission: 'people.view',
    minScope: 'SELF',
  });

  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const offset = safePage * HISTORY_PAGE_SIZE;

  // withAuthorizedDb sets app.person_id, so the 0026 SELF policy applies and
  // the caller sees only their own rows. No permission check beyond identity:
  // this is the user's own history.
  const res = await withAuthorizedDb(authz.ctx, (tx) =>
    tx.execute(
      sql`
        select
          id::text as id,
          occurred_at as "occurredAt",
          event_type as "eventType",
          ip_address::text as "ipAddress",
          user_agent as "userAgent",
          email::text as email
        from public.login_events
        order by occurred_at desc
        limit ${HISTORY_PAGE_SIZE + 1}
        offset ${offset}
      `,
    ),
  );
  const rows = res.rows as unknown as LoginHistoryRow[];

  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  return {
    rows: rows.slice(0, HISTORY_PAGE_SIZE),
    page: safePage,
    pageSize: HISTORY_PAGE_SIZE,
    hasMore,
  };
}
