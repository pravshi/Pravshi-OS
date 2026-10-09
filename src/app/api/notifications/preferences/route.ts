import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  serviceInvalidRequestResponse,
  noStoreHeaders,
} from '@/lib/work/http';
import { getEffectivePreferences, upsertPreferences } from '@/lib/notifications/preferences';

/**
 * /api/notifications/preferences — the caller's own delivery preferences.
 * Permission: notifications.preferences.manage (SELF).
 *
 * GET  → 200 { preferences: [{ eventType, channel, enabled, customized }] }
 *        the full effective matrix (11 types × 2 channels); `customized` is
 *        false when the entry is the opt-out default rather than a stored row.
 * PUT  → { preferences: [{ eventType, channel, enabled }] } (1–24 entries;
 *        eventType may be '*' for the wildcard) → 200 { ok: true, updated }
 *        Entries are upserted; unspecified entries are left untouched.
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'notifications.preferences.manage' },
  async (_request, authorization) => {
    try {
      const preferences = await getEffectivePreferences(authorization);
      return Response.json({ preferences }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PUT = withPermission(
  { permission: 'notifications.preferences.manage' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const preferences = (body as { preferences?: unknown } | undefined)?.preferences;
      const result = await upsertPreferences(authorization, preferences);
      return Response.json({ ok: true, ...result }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
