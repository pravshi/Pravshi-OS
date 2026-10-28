/**
 * Sales Sheet import retention — the proposed plan (src/lib/import/sales-sheet/retention.ts).
 * Policy pending the founder's approval (Q7); nothing here deletes anything. These tests pin
 * when an import becomes due and what a future cleanup may clear and must keep.
 */
import { describe, expect, it } from 'vitest';
import {
  CLEARED,
  KEPT,
  RETENTION_DAYS,
  retentionDecision,
  retentionDueAt,
  type ImportStatus,
} from '@/lib/import/sales-sheet/retention';

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-01-01T00:00:00Z');
const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const imp = (status: ImportStatus, completedAt: Date | null = null, createdAt = t0) => ({
  status,
  createdAt,
  completedAt,
  expiresAt: plus(createdAt, RETENTION_DAYS),
});

describe('when an import becomes due', () => {
  it('never while it is queued or running', () => {
    for (const s of ['QUEUED', 'RUNNING'] as const) {
      expect(retentionDueAt(imp(s))).toBeNull();
      expect(retentionDecision(imp(s), plus(t0, 10_000))).toEqual({
        action: 'KEEP',
        reason: 'IN_PROGRESS',
      });
    }
  });

  it('a never-confirmed preview: 90 days after upload', () => {
    expect(retentionDueAt(imp('PREVIEWED'))).toEqual(plus(t0, 90));
  });

  it('a finished import: 90 days after it finished — not after upload', () => {
    for (const s of ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] as const) {
      expect(retentionDueAt(imp(s, plus(t0, 30)))).toEqual(plus(t0, 120));
    }
  });

  it('a cancelled import: 90 days after upload (0081 records no completion time for it)', () => {
    expect(retentionDueAt(imp('CANCELLED', null))).toEqual(plus(t0, 90));
  });

  it('never earlier than the expires_at recorded at upload', () => {
    const early = { ...imp('COMPLETED', plus(t0, 1)), expiresAt: plus(t0, 200) };
    expect(retentionDueAt(early)).toEqual(plus(t0, 200));
  });

  it('a final import without a completion time counts from its upload, never from now', () => {
    expect(retentionDueAt(imp('FAILED', null))).toEqual(plus(t0, 90));
  });
});

describe('what is decided at a given time', () => {
  it('keeps until due, inclusive boundary clears', () => {
    const i = imp('COMPLETED', plus(t0, 10));
    expect(retentionDecision(i, plus(t0, 99))).toMatchObject({ action: 'KEEP', reason: 'NOT_DUE' });
    expect(retentionDecision(i, plus(t0, 100))).toMatchObject({ action: 'CLEAR' });
  });

  it('clears only raw spreadsheet values and the keys derived from them', () => {
    const d = retentionDecision(imp('COMPLETED', t0), plus(t0, 365));
    if (d.action !== 'CLEAR') throw new Error('expected CLEAR');
    expect(d.clears).toEqual([
      'crm_import_rows.source_values',
      'crm_import_rows.company_key',
      'crm_import_rows.contact_key',
      'crm_import_decisions',
    ]);
    expect(CLEARED).not.toContain('audit_logs');
  });

  it('keeps the import record, row results, plans, audit history and the CRM records', () => {
    expect(KEPT.join(' | ')).toMatch(/crm_imports/);
    expect(KEPT.join(' | ')).toMatch(/crm_import_rows \(status/);
    expect(KEPT.join(' | ')).toMatch(/crm_import_row_plans/);
    expect(KEPT.join(' | ')).toMatch(/audit_logs/);
    expect(KEPT.join(' | ')).toMatch(/companies, contacts, deals/);
  });
});
