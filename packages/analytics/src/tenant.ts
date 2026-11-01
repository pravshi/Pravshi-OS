/**
 * Phase 7 analytics — tenant identity and filter validation.
 *
 * THE TENANT RULE: orgId comes from the session, never from the request.
 * A client-supplied orgId (query param, body field, header) is ignored —
 * and if it disagrees with the session it is a protocol violation, so we
 * reject it loudly rather than silently substituting.
 */

import { resolveAuthContext } from '@/lib/auth/session';
import type { AuthContext } from '@/lib/db/context';
import { DATE_RANGE_PRESETS, DEFAULT_TIMEZONE, resolveDateRange } from './date-ranges';
import type { DashboardFilter, DateRange, DateRangePreset, TimeSeriesGrain } from './types';

export type { AuthContext };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the caller's analytics identity from the session.
 * Throws an Error with status 401 when there is no identity.
 * NEVER accept an orgId from request parameters — use ctx.orgId.
 */
export async function getAnalyticsContext(headers: Headers): Promise<AuthContext> {
  const ctx = await resolveAuthContext(headers);
  if (!ctx) {
    const err = new Error('analytics: authentication required') as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  assertValidOrgId(ctx.orgId);
  return ctx;
}

/** UUID-format check for an orgId that came from our own session layer. */
export function assertValidOrgId(orgId: unknown): asserts orgId is string {
  if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) {
    throw new Error('analytics: invalid orgId in session context');
  }
}

/**
 * If a request smuggles an orgId, verify it matches the session — and always
 * use the session's. Mismatch → throw (do not fall back, do not ignore).
 */
export function reconcileOrgId(sessionOrgId: string, claimedOrgId: unknown): string {
  if (claimedOrgId === undefined || claimedOrgId === null || claimedOrgId === '')
    return sessionOrgId;
  if (claimedOrgId !== sessionOrgId) {
    throw new Error('analytics: request orgId does not match session orgId');
  }
  return sessionOrgId;
}

const GRAINS: readonly TimeSeriesGrain[] = ['day', 'week', 'month'] as const;

interface RawFilter {
  preset?: unknown;
  timezone?: unknown;
  customStart?: unknown;
  customEnd?: unknown;
  grain?: unknown;
  comparePreset?: unknown;
  compareStart?: unknown;
  compareEnd?: unknown;
  /** Deliberately NOT read as identity; only reconciled. */
  orgId?: unknown;
}

/**
 * Validate an untrusted dashboard filter body/query into a DashboardFilter.
 * Session orgId is threaded through separately — see getAnalyticsContext +
 * reconcileOrgId — and is never trusted from here.
 */
export function validateDashboardFilter(
  raw: unknown,
  sessionOrgId: string,
  now?: Date,
): { filter: DashboardFilter; orgId: string } {
  const body = (raw ?? {}) as RawFilter;

  const preset = body.preset ?? 'LAST_30_DAYS';
  if (typeof preset !== 'string' || !(DATE_RANGE_PRESETS as readonly string[]).includes(preset)) {
    throw new Error(`analytics: invalid preset: ${JSON.stringify(preset)}`);
  }
  const tz = body.timezone ?? DEFAULT_TIMEZONE;
  if (typeof tz !== 'string') throw new Error('analytics: timezone must be a string');

  const dateRange: DateRange = resolveDateRange(preset as DateRangePreset, {
    timezone: tz,
    now,
    customStart: typeof body.customStart === 'string' ? body.customStart : undefined,
    customEnd: typeof body.customEnd === 'string' ? body.customEnd : undefined,
  });

  let grain: TimeSeriesGrain | undefined;
  if (body.grain !== undefined) {
    if (typeof body.grain !== 'string' || !(GRAINS as readonly string[]).includes(body.grain)) {
      throw new Error(`analytics: invalid grain: ${JSON.stringify(body.grain)}`);
    }
    grain = body.grain as TimeSeriesGrain;
  }

  let compareRange: DateRange | undefined;
  if (body.comparePreset !== undefined) {
    if (
      typeof body.comparePreset !== 'string' ||
      !(DATE_RANGE_PRESETS as readonly string[]).includes(body.comparePreset)
    ) {
      throw new Error(`analytics: invalid comparePreset: ${JSON.stringify(body.comparePreset)}`);
    }
    compareRange = resolveDateRange(body.comparePreset as DateRangePreset, {
      timezone: tz,
      now,
      customStart: typeof body.compareStart === 'string' ? body.compareStart : undefined,
      customEnd: typeof body.compareEnd === 'string' ? body.compareEnd : undefined,
    });
  }

  const orgId = reconcileOrgId(sessionOrgId, body.orgId);

  return { filter: { dateRange, grain, compareRange }, orgId };
}
