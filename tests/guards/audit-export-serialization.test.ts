import { describe, expect, it } from 'vitest';
import {
  csvEscapeCell,
  auditRecordToCsvRow,
  auditRecordToJson,
  AUDIT_CSV_HEADER,
  type AuditExportRecord,
} from '@/lib/admin/audit-export';

/** Pure serialization for the audit export — no database needed. */

function record(overrides: Partial<AuditExportRecord> = {}): AuditExportRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    occurredAt: new Date('2026-09-28T10:00:00.000Z'),
    actor: 'admin@example.com',
    action: 'user.invite',
    severity: 'MEDIUM',
    entityType: 'invitation',
    entityId: '22222222-2222-2222-2222-222222222222',
    result: 'SUCCESS',
    before: null,
    after: null,
    metadata: { code: 'INV-1' },
    ...overrides,
  };
}

describe('csvEscapeCell', () => {
  it('leaves plain cells untouched', () => {
    expect(csvEscapeCell('user.invite')).toBe('user.invite');
  });
  it('quotes cells with commas, quotes, or line breaks and doubles quotes', () => {
    expect(csvEscapeCell('a,b')).toBe('"a,b"');
    expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscapeCell('a\rb')).toBe('"a\rb"');
  });
  it('treats null/undefined as empty', () => {
    expect(csvEscapeCell(null)).toBe('');
    expect(csvEscapeCell(undefined)).toBe('');
  });
});

describe('auditRecordToCsvRow', () => {
  it('emits the six documented columns in order', () => {
    expect(AUDIT_CSV_HEADER).toBe('timestamp,actor,action,severity,entity,details');
    const row = auditRecordToCsvRow(record());
    expect(
      row.startsWith('2026-09-28T10:00:00.000Z,admin@example.com,user.invite,MEDIUM,invitation,'),
    ).toBe(true);
    // details is a JSON cell carrying result, entity id, and metadata
    const details = row.slice(row.indexOf(',"{'));
    expect(details).toContain('SUCCESS');
    expect(details).toContain('22222222-2222-2222-2222-222222222222');
    expect(details).toContain('INV-1');
  });
  it('escapes hostile cell content', () => {
    const row = auditRecordToCsvRow(
      record({ actor: 'evil",=cmd\ninjected', metadata: { note: 'a"b,c' } }),
    );
    expect(row).toContain('"evil"",=cmd\ninjected"');
  });
});

describe('auditRecordToJson', () => {
  it('carries the full record with ISO dates', () => {
    const json = auditRecordToJson(record());
    expect(json).toMatchObject({
      id: '11111111-1111-1111-1111-111111111111',
      occurredAt: '2026-09-28T10:00:00.000Z',
      actor: 'admin@example.com',
      action: 'user.invite',
      severity: 'MEDIUM',
      entityType: 'invitation',
      result: 'SUCCESS',
    });
    expect(json.metadata).toEqual({ code: 'INV-1' });
  });
});
