/**
 * Phase 8 — Notifications: delivery preferences (Workstream C).
 *
 * [CONTRACT] §16.5: (userId, orgId, eventType, channel, enabled) with '*'
 *            wildcard eventType; specific eventType overrides '*'.
 * [TABLE]    public.notification_preferences (migration 0052, Workstream A):
 *            org_id, person_id, event_type text, channel text CHECK, enabled
 *            boolean, unique (org_id, person_id, event_type, channel), RLS.
 *
 * Resolution rule (binding): a row for the exact eventType wins over a '*'
 * row; when neither exists the channel is ENABLED (opt-out model — users
 * silence what they don't want rather than opting into every type).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NotificationChannelSchema,
  NotificationEventTypeSchema,
  type NotificationChannel,
  type NotificationEventType,
} from './types';

export const PreferenceEventTypeSchema = z.union([NotificationEventTypeSchema, z.literal('*')]);
export type PreferenceEventType = NotificationEventType | '*';

/** One stored preference row (what PUT accepts, minus user/org which are the caller's). */
export const UpsertPreferenceSchema = z.strictObject({
  eventType: PreferenceEventTypeSchema,
  channel: NotificationChannelSchema,
  enabled: z.boolean(),
});
export type UpsertPreference = z.infer<typeof UpsertPreferenceSchema>;

export const UpsertPreferencesBodySchema = z.strictObject({
  preferences: z.array(UpsertPreferenceSchema).min(1).max(24),
});

type StoredPreferenceRow = {
  event_type: string;
  channel: string;
  enabled: boolean;
};

export interface EffectivePreference {
  eventType: NotificationEventType | '*';
  channel: NotificationChannel;
  /** Resolved enabled flag after wildcard/default rules. */
  enabled: boolean;
  /** True when a stored row (exact or wildcard) decided the flag. */
  customized: boolean;
}

/**
 * Pure wildcard resolution: the exact (eventType, channel) row wins, then the
 * ('*', channel) row, then the default (enabled). Unit-testable without a DB.
 */
export function resolveEffectiveEnabled(
  rows: ReadonlyArray<{ eventType: string; channel: string; enabled: boolean }>,
  eventType: string,
  channel: string,
): { enabled: boolean; customized: boolean } {
  const specific = rows.find((r) => r.eventType === eventType && r.channel === channel);
  if (specific !== undefined) return { enabled: specific.enabled, customized: true };
  const wildcard = rows.find((r) => r.eventType === '*' && r.channel === channel);
  if (wildcard !== undefined) return { enabled: wildcard.enabled, customized: true };
  return { enabled: true, customized: false };
}

/**
 * Pure: builds the full effective matrix (12 event types × 2 channels) from
 * stored rows. The frontend settings screen renders this directly.
 */
export function buildEffectivePreferences(
  rows: ReadonlyArray<{ eventType: string; channel: string; enabled: boolean }>,
): EffectivePreference[] {
  const out: EffectivePreference[] = [];
  for (const eventType of NOTIFICATION_EVENT_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const { enabled, customized } = resolveEffectiveEnabled(rows, eventType, channel);
      out.push({ eventType, channel, enabled, customized });
    }
  }
  return out;
}

function requirePersonId(auth: Authorization): string {
  const personId = auth.ctx.personId;
  if (personId === null || personId === undefined || personId === '') {
    throw new Error('INVALID_REQUEST: notification preferences require a person identity');
  }
  return personId;
}

/** Stored rows for one person (caller's own — enforced by person_id = caller). */
export async function getStoredPreferences(
  auth: Authorization,
  personId: string,
): Promise<StoredPreferenceRow[]> {
  const result = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<StoredPreferenceRow>(sql`
      select event_type, channel, enabled
      from public.notification_preferences
      where org_id = ${auth.ctx.orgId}::uuid
        and person_id = ${personId}::uuid
    `),
  );
  return result.rows;
}

/** The caller's own effective preference matrix (24 entries). */
export async function getEffectivePreferences(auth: Authorization): Promise<EffectivePreference[]> {
  const personId = requirePersonId(auth);
  const rows = await getStoredPreferences(auth, personId);
  return buildEffectivePreferences(
    rows.map((r) => ({ eventType: r.event_type, channel: r.channel, enabled: r.enabled })),
  );
}

/**
 * Whether a channel is enabled for (personId, eventType). Used by the service
 * before enqueueing in-app/email jobs. Pure default: enabled.
 *
 * This runs under the CREATOR's identity while the preference rows belong to
 * the RECIPIENT, and notification_preferences_select is own-rows only — a
 * direct table read here can only ever see the creator's own rows, so the
 * gate silently defaulted to enabled for every cross-user notification
 * (proven in Phase 8 DB verification). The read therefore goes through the
 * bounded SECURITY DEFINER function from migration 0052, which answers this
 * one boolean for the exact (org, person, event, channel) tuple with the
 * same resolution semantics as resolveEffectiveEnabled().
 */
export async function isChannelEnabled(
  auth: Authorization,
  personId: string,
  eventType: NotificationEventType,
  channel: NotificationChannel,
): Promise<boolean> {
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ enabled: boolean }>(sql`
      select public.notification_channel_enabled(
        ${auth.ctx.orgId}::uuid,
        ${personId}::uuid,
        ${eventType},
        ${channel}
      ) as enabled
    `),
  );
  return rows.rows[0]?.enabled === true;
}

/**
 * Upserts the caller's own preferences (PUT). Each entry is validated;
 * unknown event types/channels are rejected (400). person_id is ALWAYS the
 * caller — there is no path to write another person's preferences.
 * Returns the number of entries written.
 */
export async function upsertPreferences(
  auth: Authorization,
  preferences: unknown,
): Promise<{ updated: number }> {
  const personId = requirePersonId(auth);
  const parsed = UpsertPreferencesBodySchema.parse({ preferences });
  const orgId = auth.ctx.orgId;

  await withAuthorizedDb(auth.ctx, async (tx) => {
    for (const pref of parsed.preferences) {
      await tx.execute(sql`
        insert into public.notification_preferences
          (org_id, person_id, event_type, channel, enabled)
        values
          (${orgId}::uuid, ${personId}::uuid, ${pref.eventType}, ${pref.channel}, ${pref.enabled})
        on conflict (org_id, person_id, event_type, channel)
        do update set enabled = excluded.enabled
      `);
    }
  });
  return { updated: parsed.preferences.length };
}
