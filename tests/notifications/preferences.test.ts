/**
 * Phase 8 — notification preferences: pure unit tests (no DB).
 *
 * The wildcard resolution rule (§16.5) is pure and fully covered here; the
 * DB-backed functions (getStoredPreferences / upsertPreferences) run against
 * the migration-0052 table and are covered by the integration pass.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEffectivePreferences,
  resolveEffectiveEnabled,
  UpsertPreferenceSchema,
} from '@/lib/notifications/preferences';

describe('resolveEffectiveEnabled', () => {
  it('defaults to enabled when no rows exist (opt-out model)', () => {
    expect(resolveEffectiveEnabled([], 'TASK_ASSIGNED', 'in_app')).toEqual({
      enabled: true,
      customized: false,
    });
    expect(resolveEffectiveEnabled([], 'MENTION', 'email')).toEqual({
      enabled: true,
      customized: false,
    });
  });

  it('applies the wildcard row when no specific row exists', () => {
    const rows = [{ eventType: '*', channel: 'email', enabled: false }];
    expect(resolveEffectiveEnabled(rows, 'TASK_DUE', 'email')).toEqual({
      enabled: false,
      customized: true,
    });
    // …but not to the other channel
    expect(resolveEffectiveEnabled(rows, 'TASK_DUE', 'in_app')).toEqual({
      enabled: true,
      customized: false,
    });
  });

  it('prefers the specific eventType row over the wildcard', () => {
    const rows = [
      { eventType: '*', channel: 'in_app', enabled: false },
      { eventType: 'MENTION', channel: 'in_app', enabled: true },
    ];
    expect(resolveEffectiveEnabled(rows, 'MENTION', 'in_app')).toEqual({
      enabled: true,
      customized: true,
    });
    expect(resolveEffectiveEnabled(rows, 'TASK_ASSIGNED', 'in_app')).toEqual({
      enabled: false,
      customized: true,
    });
  });

  it('a specific disable beats a wildcard enable', () => {
    const rows = [
      { eventType: '*', channel: 'email', enabled: true },
      { eventType: 'SYSTEM_ALERT', channel: 'email', enabled: false },
    ];
    expect(resolveEffectiveEnabled(rows, 'SYSTEM_ALERT', 'email').enabled).toBe(false);
  });
});

describe('buildEffectivePreferences', () => {
  it('builds the full 11×2 matrix, all enabled by default', () => {
    const matrix = buildEffectivePreferences([]);
    expect(matrix).toHaveLength(22);
    expect(matrix.every((p) => p.enabled && !p.customized)).toBe(true);
    const channels = new Set(matrix.map((p) => p.channel));
    expect(channels).toEqual(new Set(['in_app', 'email']));
  });

  it('marks overridden entries customized', () => {
    const matrix = buildEffectivePreferences([
      { eventType: '*', channel: 'email', enabled: false },
    ]);
    const emailEntries = matrix.filter((p) => p.channel === 'email');
    const inAppEntries = matrix.filter((p) => p.channel === 'in_app');
    expect(emailEntries.every((p) => !p.enabled && p.customized)).toBe(true);
    expect(inAppEntries.every((p) => p.enabled && !p.customized)).toBe(true);
  });
});

describe('UpsertPreferenceSchema', () => {
  it('accepts the wildcard eventType', () => {
    expect(
      UpsertPreferenceSchema.safeParse({ eventType: '*', channel: 'email', enabled: false })
        .success,
    ).toBe(true);
  });

  it('rejects unknown event types, channels, and non-boolean flags', () => {
    expect(
      UpsertPreferenceSchema.safeParse({
        eventType: 'BOGUS',
        channel: 'email',
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      UpsertPreferenceSchema.safeParse({
        eventType: 'MENTION',
        channel: 'sms',
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      UpsertPreferenceSchema.safeParse({
        eventType: 'MENTION',
        channel: 'in_app',
        enabled: 'yes',
      }).success,
    ).toBe(false);
  });
});
