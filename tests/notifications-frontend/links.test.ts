/**
 * Phase 8 — Notifications frontend: link-building + view metadata tests
 * (Workstream E). Pure unit tests, no DB.
 *
 * These pin the safe-navigation contract: a deep link is produced ONLY for
 * an allowlisted entity type with a UUID id (and never for 'person', which
 * has no detail page). The server-side resolver (resolve-links.ts) adds the
 * permission + existence + RLS checks on top; that layer is covered by the
 * DB integration pass (Workstream F).
 */
import { describe, expect, it } from 'vitest';
import {
  buildEntityLink,
  EVENT_TYPE_META,
  formatRelativeTime,
} from '@/components/notifications/notifications-view';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/notifications/types';

const UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

describe('buildEntityLink', () => {
  it('builds deep links for all 7 linkable entity types', () => {
    expect(buildEntityLink('contact', UUID)).toBe(`/crm/contacts/${UUID}`);
    expect(buildEntityLink('company', UUID)).toBe(`/crm/companies/${UUID}`);
    expect(buildEntityLink('deal', UUID)).toBe(`/crm/deals/${UUID}`);
    expect(buildEntityLink('activity', UUID)).toBe(`/crm/activities/${UUID}`);
    expect(buildEntityLink('project', UUID)).toBe(`/work/projects/${UUID}`);
    expect(buildEntityLink('task', UUID)).toBe(`/work/tasks/${UUID}`);
    expect(buildEntityLink('workflow', UUID)).toBe(`/workflows/${UUID}`);
  });

  it('never links a person (no person detail page exists)', () => {
    expect(buildEntityLink('person', UUID)).toBeNull();
  });

  it('rejects unknown entity types (fail-closed)', () => {
    expect(buildEntityLink('lead', UUID)).toBeNull();
    expect(buildEntityLink('invoice', UUID)).toBeNull();
    expect(buildEntityLink('', UUID)).toBeNull();
    expect(buildEntityLink(undefined, UUID)).toBeNull();
  });

  it('rejects non-UUID entity ids (fail-closed)', () => {
    expect(buildEntityLink('deal', 'not-a-uuid')).toBeNull();
    expect(buildEntityLink('deal', '')).toBeNull();
    expect(buildEntityLink('deal', undefined)).toBeNull();
    expect(buildEntityLink('deal', '1')).toBeNull();
  });

  it('rejects injection-shaped entity types', () => {
    expect(buildEntityLink("deal'; DROP TABLE deals; --", UUID)).toBeNull();
    expect(buildEntityLink('../admin/users', UUID)).toBeNull();
    expect(buildEntityLink('DEAL', UUID)).toBeNull(); // case-sensitive allowlist
  });
});

describe('EVENT_TYPE_META', () => {
  it('covers all 11 event types with non-empty labels and descriptions', () => {
    expect(NOTIFICATION_EVENT_TYPES).toHaveLength(11);
    for (const t of NOTIFICATION_EVENT_TYPES) {
      const meta = EVENT_TYPE_META[t];
      expect(meta, `missing meta for ${t}`).toBeDefined();
      expect(meta.label.trim().length).toBeGreaterThan(0);
      expect(meta.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('formatRelativeTime', () => {
  it('says "just now" for very recent and future timestamps', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
    expect(formatRelativeTime(new Date(Date.now() + 60_000).toISOString())).toBe('just now');
  });

  it('formats minutes, hours, and days compactly', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(formatRelativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(formatRelativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });

  it('falls back to a date for old timestamps and empty for invalid input', () => {
    const old = formatRelativeTime(new Date(Date.now() - 60 * 86_400_000).toISOString());
    expect(old.length).toBeGreaterThan(0);
    expect(old).not.toContain('ago');
    expect(formatRelativeTime('not-a-date')).toBe('');
  });
});
