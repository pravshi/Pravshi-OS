/**
 * Sales Sheet import retention — the PLAN only (proposed policy, founder decision Q7 pending).
 *
 * This module decides, for one import, whether a future cleanup may clear it yet and exactly
 * what it would clear and keep. It touches no database and deletes nothing: no cleanup runs
 * until the policy below is approved and a separate, reviewed change implements it
 * (docs/import/sales-sheet-retention.md).
 *
 * Four kinds of data, treated differently:
 *   1. Import metadata (crm_imports: who, when, file name and hash, status, counts) — KEPT: it is
 *      the record that an import happened and what it did.
 *   2. Row-level results (crm_import_rows: status, the ids of the records created or linked,
 *      error reasons — which never carry values; crm_import_row_plans: skip and record ids) —
 *      KEPT.
 *   3. Raw spreadsheet values and everything derived from them that names a person or company:
 *      crm_import_rows.source_values, its company_key / contact_key (normalised names and
 *      emails), and the duplicate decisions' entity keys — CLEARED once due.
 *   4. Audit history (audit_logs crm.import.*; platform audit) — NEVER touched by import
 *      retention: audit has its own retention.
 * The CRM records an import created are business data, not import data: never touched.
 *
 * The clock: 90 days from when the import stopped changing — its completion (completed, with
 * errors, failed) — or from its upload if it was never confirmed or was cancelled (0081 records
 * no completion time for a cancellation). Never earlier than
 * the expires_at recorded at upload. An import QUEUED or RUNNING is never due (an abandoned one
 * is first failed by crm_import_fail_abandoned, which starts its clock).
 */
export const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ImportStatus =
  | 'PREVIEWED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_ERRORS'
  | 'FAILED'
  | 'CANCELLED';

export interface RetentionInput {
  status: ImportStatus;
  createdAt: Date;
  /** When the import reached its final state; null if it never did. */
  completedAt: Date | null;
  /** Recorded at upload (0081): created_at + 90 days. A floor, never moved earlier. */
  expiresAt: Date;
}

/** What a cleanup clears: raw spreadsheet values, and the keys derived from them. */
export const CLEARED = [
  'crm_import_rows.source_values',
  'crm_import_rows.company_key',
  'crm_import_rows.contact_key',
  'crm_import_decisions',
] as const;

/** What it keeps: the import's record, its row-level results, and everything outside it. */
export const KEPT = [
  'crm_imports (metadata, counts, status, timestamps)',
  'crm_import_rows (status, created/linked record ids, error reasons)',
  'crm_import_row_plans (skip, record ids)',
  'audit_logs (crm.import.* entries — audit retention applies, not this)',
  'companies, contacts, deals created or linked by the import',
] as const;

export type RetentionDecision =
  | { action: 'KEEP'; reason: 'IN_PROGRESS' }
  | { action: 'KEEP'; reason: 'NOT_DUE'; dueAt: Date }
  | { action: 'CLEAR'; dueAt: Date; clears: typeof CLEARED; keeps: typeof KEPT };

const FINAL: ReadonlySet<ImportStatus> = new Set([
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
]);

/** When an import becomes due, or null while it is in progress. */
export function retentionDueAt(i: RetentionInput): Date | null {
  if (i.status === 'QUEUED' || i.status === 'RUNNING') return null;
  // A final import whose completion time is missing counts from its upload — never from "now".
  const start = FINAL.has(i.status) ? (i.completedAt ?? i.createdAt) : i.createdAt;
  const due = start.getTime() + RETENTION_DAYS * DAY_MS;
  return new Date(Math.max(due, i.expiresAt.getTime()));
}

export function retentionDecision(i: RetentionInput, now: Date): RetentionDecision {
  const dueAt = retentionDueAt(i);
  if (dueAt === null) return { action: 'KEEP', reason: 'IN_PROGRESS' };
  if (now.getTime() < dueAt.getTime()) return { action: 'KEEP', reason: 'NOT_DUE', dueAt };
  return { action: 'CLEAR', dueAt, clears: CLEARED, keeps: KEPT };
}
