/**
 * Phase 8 — Notifications frontend: server-side deep-link resolution
 * (Workstream E).
 *
 * SERVER ONLY: imports drizzle/withAuthorizedDb. Never import from a client
 * component — clients receive resolved `link` values as props.
 *
 * Safe navigation (§16.9): a notification's entityType/entityId becomes a
 * clickable link ONLY when ALL of these hold:
 *   1. entityType is one of the 8 approved types and entityId is a UUID
 *      (pure allowlist in buildEntityLink — fail-closed);
 *   2. the caller holds the entity's view permission
 *      (entityViewScopes, Workstream B — fail-closed);
 *   3. the row exists in the caller's org, is not soft-deleted, and is
 *      visible through the scope-aware SELECT RLS policy
 *      (withAuthorizedDb — the same policies the entity pages use).
 *
 * Otherwise the notification carries `link: null` and the UI renders an
 * "unavailable" state — never a broken or unauthorized link.
 */
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import { entityConfig } from '@/lib/search/entities';
import { entityViewScopes } from '@/lib/search/permissions';
import { isSearchEntityType, type SearchEntityType } from '@/lib/search/types';
import type { Notification } from '@/lib/notifications/types';
import {
  buildEntityLink,
  type NotificationWithLink,
} from '@/components/notifications/notifications-view';

export type { NotificationWithLink };

/**
 * Resolves verified deep links for a page of the caller's OWN notifications.
 * Batched: one existence query per entity type (never N+1), one scope query.
 */
export async function resolveNotificationLinks(
  auth: Authorization,
  notifications: readonly Notification[],
): Promise<NotificationWithLink[]> {
  const out = new Map<string, string | null>();

  // Pass 1: pure candidate links (allowlist + UUID + no 'person').
  const candidates = new Map<string, { entityType: SearchEntityType; entityId: string }>();
  for (const n of notifications) {
    const link = buildEntityLink(n.entityType, n.entityId);
    if (link !== null && isSearchEntityType(n.entityType) && typeof n.entityId === 'string') {
      candidates.set(n.id, {
        entityType: n.entityType,
        entityId: n.entityId,
      });
    } else {
      out.set(n.id, null);
    }
  }
  if (candidates.size === 0) {
    return notifications.map((n) => ({ ...n, link: out.get(n.id) ?? null }));
  }

  // Pass 2: the caller must hold each entity's view permission (fail-closed).
  const scopes = await entityViewScopes(auth.ctx);
  const permitted = new Map<string, { entityType: SearchEntityType; entityId: string }>();
  for (const [id, c] of candidates) {
    if (scopes[c.entityType] !== null) {
      permitted.set(id, c);
    } else {
      out.set(id, null);
    }
  }

  // Pass 3: batched existence + soft-delete + scope-aware RLS visibility.
  const byType = new Map<SearchEntityType, { id: string; entityId: string }[]>();
  for (const [id, c] of permitted) {
    const list = byType.get(c.entityType) ?? [];
    list.push({ id, entityId: c.entityId });
    byType.set(c.entityType, list);
  }
  for (const [entityType, entries] of byType) {
    // Trusted table name from the frozen search registry (never user input).
    const table = entityConfig(entityType).table;
    const ids = entries.map((e) => e.entityId);
    const visible = await withAuthorizedDb(auth.ctx, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id::text as id
        from ${sql.raw(table)}
        where id = any(${ids}::uuid[])
          and org_id = ${auth.ctx.orgId}::uuid
          and deleted_at is null
      `),
    );
    const visibleIds = new Set(visible.rows.map((r) => r.id));
    for (const e of entries) {
      // Rebuild the link from the allowlisted registry — never trust a
      // freeform `link` carried in the notification payload.
      out.set(e.id, visibleIds.has(e.entityId) ? buildEntityLink(entityType, e.entityId) : null);
    }
  }

  return notifications.map((n) => ({ ...n, link: out.get(n.id) ?? null }));
}
