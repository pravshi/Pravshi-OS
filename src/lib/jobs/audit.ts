/**
 * Phase 6 — fail-open audit writer for job/schedule mutations.
 *
 * Convention (matches src/lib/crm/*, src/lib/auth/*, src/lib/admin/*):
 *   await writeAuditEntry(auth.ctx, { action, entityType, entityId, result,
 *     severity, metadata }, auth.meta)
 *
 * writeAuditEntry runs in its own transaction and derives the actor/org from
 * the identity in auth.ctx — a caller cannot name another actor or tenant.
 *
 * This wrapper is fail-open FOR AUDIT and fail-closed for the operation:
 * the mutation has already committed before this runs, so an audit-write
 * failure only loses the trail — it is logged and swallowed rather than
 * turned into an operation error (which would misreport a succeeded
 * mutation as failed).
 */
import { writeAuditEntry, type AuditSeverity } from '@/lib/audit/log';
import type { Authorization } from '@/lib/authz/require-permission';

export interface JobsAuditInput {
  readonly action: string;
  readonly entityType: 'job' | 'schedule';
  readonly entityId: string;
  readonly severity: AuditSeverity;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Writes one audit entry; never throws. */
export async function auditJobsMutation(auth: Authorization, input: JobsAuditInput): Promise<void> {
  try {
    await writeAuditEntry(
      auth.ctx,
      {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        result: 'SUCCESS',
        severity: input.severity,
        metadata: { ...(input.metadata ?? {}) },
      },
      auth.meta,
    );
  } catch (error) {
    console.warn(
      `[jobs] audit write failed action=${input.action} ` +
        `${input.entityType}=${input.entityId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
