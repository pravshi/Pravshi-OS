import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';

/**
 * The application-layer audit writer — blueprint section 24's `audit.log()`, and the intent half
 * of section 19.3: denied authorizations, and later downloads, exports and the other events a
 * row trigger cannot see.
 *
 * Every entry goes through public.write_audit_log(), which derives the actor and the
 * organization from the identity in the transaction. Nothing here can name another actor or
 * place an entry in another tenant.
 *
 * ── ITS OWN TRANSACTION, ALWAYS ──────────────────────────────────────────────────
 *
 * Each call commits on its own. A denial is recorded on the way to a refused request, and if it
 * shared that request's transaction the refusal would roll the evidence back with it.
 *
 * ── WHAT CAN REACH IT ────────────────────────────────────────────────────────────
 *
 * Only the fields below. The request contributes a request id, the platform-supplied client
 * address and the user agent — no other header, no cookie, no body. Metadata values are flat
 * primitives, so a whole object that happens to hold a token cannot be passed in whole.
 * write_audit_log() strips obvious credential keys as a backstop, but nothing should rely on it.
 */

export type AuditSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AuditResult = 'SUCCESS' | 'DENIED' | 'ERROR';

export interface RequestMetadata {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly result: AuditResult;
  readonly severity: AuditSeverity;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

const USER_AGENT_MAX = 512;

/**
 * The request facts an audit entry may carry. The client address is the first hop of
 * x-forwarded-for, which the platform sets; it is informational only and never used to decide
 * anything. A value that is not an IP literal is dropped rather than stored.
 */
export function requestMetadata(headers: Headers, requestId: string): RequestMetadata {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const agent = headers.get('user-agent');
  return {
    requestId,
    ip: isIP(first) ? first : null,
    userAgent: agent ? agent.slice(0, USER_AGENT_MAX) : null,
  };
}

/** Writes one entry, attributed by the database to ctx's person, in its own transaction. */
export async function writeAuditEntry(
  ctx: AuthContext,
  entry: AuditEntry,
  meta: RequestMetadata,
): Promise<void> {
  await withAuthorizedDb(ctx, (tx) =>
    tx.execute(sql`
      select public.write_audit_log(
        p_action      := ${entry.action},
        p_entity_type := ${entry.entityType},
        p_result      := ${entry.result}::public.audit_result,
        p_entity_id   := ${entry.entityId ?? null}::uuid,
        p_severity    := ${entry.severity},
        p_metadata    := ${JSON.stringify(entry.metadata ?? {})}::jsonb,
        p_request_id  := ${meta.requestId}::uuid,
        p_actor_ip    := ${meta.ip}::inet,
        p_user_agent  := ${meta.userAgent}
      )
    `),
  );
}

export const audit = { log: writeAuditEntry };
