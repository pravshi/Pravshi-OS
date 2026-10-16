/**
 * Phase 6 — audit writer for job/schedule mutations.
 *
 * Runs INSIDE the mutation's transaction (V1 audit TI-18 / MT-M3), the same pattern as
 * invitation issuance (src/lib/invitations/service.ts). The entry goes through
 * public.write_audit_log(), which derives the actor and org from the transaction's
 * identity — a caller cannot name another actor or tenant — with the same fields
 * writeAuditEntry() (src/lib/audit/log.ts) passes.
 *
 * The audit is fail-closed: an audit-write failure raises, the transaction rolls back
 * and the operation reports the error. No job or schedule change commits without its
 * entry, and a rolled-back change leaves no entry behind. (Previously the entry was
 * written in its own transaction after the mutation had committed, and a failure was
 * only logged.)
 */
import { sql } from 'drizzle-orm';
import type { AuditSeverity } from '@/lib/audit/log';
import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';

export interface JobsAuditInput {
  readonly action: string;
  readonly entityType: 'job' | 'schedule';
  readonly entityId: string;
  readonly severity: AuditSeverity;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Writes one audit entry in `tx`, the mutation's own transaction. Throws on failure. */
export async function auditJobsMutation(
  tx: Tx,
  auth: Authorization,
  input: JobsAuditInput,
): Promise<void> {
  await tx.execute(sql`
    select public.write_audit_log(
      p_action      := ${input.action},
      p_entity_type := ${input.entityType},
      p_result      := 'SUCCESS'::public.audit_result,
      p_entity_id   := ${input.entityId}::uuid,
      p_severity    := ${input.severity},
      p_metadata    := ${JSON.stringify(input.metadata ?? {})}::jsonb,
      p_request_id  := ${auth.meta.requestId}::uuid,
      p_actor_ip    := ${auth.meta.ip}::inet,
      p_user_agent  := ${auth.meta.userAgent}
    )
  `);
}
