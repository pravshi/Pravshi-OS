/**
 * Phase 8 — Notifications frontend: preference view-model tests (Workstream E).
 * Pure unit tests, no DB. Pins the settings table semantics: the '*' wildcard
 * row reflects the stored wildcard (default enabled); per-type rows reflect
 * the effective matrix (specific > wildcard > default).
 */
import { describe, expect, it } from 'vitest';
import { buildPreferenceViewModel } from '@/components/notifications/notifications-view';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/notifications/types';

describe('buildPreferenceViewModel', () => {
  it('returns 13 rows: wildcard first, then the 12 event types', () => {
    const rows = buildPreferenceViewModel([], []);
    expect(rows).toHaveLength(13);
    expect(rows[0]!.key).toBe('*');
    expect(rows[0]!.label).toBe('All event types');
    expect(rows.slice(1).map((r) => r.key)).toEqual([...NOTIFICATION_EVENT_TYPES]);
  });

  it('defaults the wildcard row to enabled and not customized with no stored rows', () => {
    const rows = buildPreferenceViewModel([], []);
    expect(rows[0]!.inApp).toEqual({ enabled: true, customized: false });
    expect(rows[0]!.email).toEqual({ enabled: true, customized: false });
  });

  it('reflects a stored wildcard row on the wildcard row only', () => {
    const stored = [{ eventType: '*', channel: 'email', enabled: false }];
    const rows = buildPreferenceViewModel(stored, []);
    expect(rows[0]!.email).toEqual({ enabled: false, customized: true });
    expect(rows[0]!.inApp).toEqual({ enabled: true, customized: false });
  });

  it('passes the effective matrix through to per-type rows', () => {
    const effective = [
      { eventType: 'MENTION', channel: 'in_app' as const, enabled: false, customized: true },
      { eventType: 'MENTION', channel: 'email' as const, enabled: true, customized: false },
    ];
    const rows = buildPreferenceViewModel([], effective);
    const mention = rows.find((r) => r.key === 'MENTION')!;
    expect(mention.inApp).toEqual({ enabled: false, customized: true });
    expect(mention.email).toEqual({ enabled: true, customized: false });
    // Other types fall back to the enabled default.
    const task = rows.find((r) => r.key === 'TASK_ASSIGNED')!;
    expect(task.inApp).toEqual({ enabled: true, customized: false });
  });

  it('ignores stored rows for channels they do not belong to', () => {
    const stored = [{ eventType: '*', channel: 'in_app', enabled: false }];
    const rows = buildPreferenceViewModel(stored, []);
    expect(rows[0]!.inApp.enabled).toBe(false);
    expect(rows[0]!.email.enabled).toBe(true);
  });
});
