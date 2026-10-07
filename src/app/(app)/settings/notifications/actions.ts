'use server';

/**
 * Phase 8 — Notification preferences page: Server Actions (Workstream E).
 *
 * Authorize first, always: requirePermission('notifications.preferences.manage')
 * is the first statement. The stored/effective rows returned are the caller's
 * own (the preferences service scopes every query to the caller's person_id).
 */
import { headers } from 'next/headers';
import { requirePermission } from '@/lib/authz/require-permission';
import { getEffectivePreferences, getStoredPreferences } from '@/lib/notifications/preferences';
import type { StoredPreference } from '@/components/notifications/notifications-view';

export async function getPreferencesPageData() {
  const auth = await requirePermission(await headers(), {
    permission: 'notifications.preferences.manage',
  });
  const [storedRows, effective] = await Promise.all([
    getStoredPreferences(auth, auth.ctx.personId),
    getEffectivePreferences(auth),
  ]);
  const stored: StoredPreference[] = storedRows.map((r) => ({
    eventType: r.event_type,
    channel: r.channel,
    enabled: r.enabled,
  }));
  return { stored, effective };
}
