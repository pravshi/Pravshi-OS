/**
 * Phase 8 — Notifications frontend: pure view helpers (Workstream E).
 *
 * Client-safe: no DB, no server imports. Safe to import from client
 * components AND to unit-test without a database.
 *
 * XSS note: notification titles/bodies are ALWAYS rendered as React text
 * nodes (never dangerouslySetInnerHTML), so React's escaping is the
 * sanitizer. This module never builds HTML strings.
 */
import { z } from 'zod';
import { entityConfig } from '@/lib/search/entities';
import { isSearchEntityType, type SearchEntityType } from '@/lib/search/types';
import {
  NOTIFICATION_EVENT_TYPES,
  type Notification,
  type NotificationChannel,
  type NotificationEventType,
} from '@/lib/notifications/types';

/** A notification with its deep link resolved (null = unavailable). */
export interface NotificationWithLink extends Notification {
  /**
   * Verified deep link, or null when the entity is missing, deleted,
   * inaccessible to the viewer, or has no detail page. The UI must render
   * an "unavailable" state for null — never a guessed or unauthorized URL.
   */
  link: string | null;
}

const uuidSchema = z.string().uuid();

/**
 * Pure: builds the deep link for a notification's entity reference, or null.
 * Fail-closed: unknown entityType, non-UUID entityId, and the 'person' type
 * (no person detail page exists in the app) all yield null.
 *
 * This is only the *candidate* link. The server-side resolver
 * (src/app/(app)/notifications/resolve-links.ts) additionally verifies the
 * caller holds the entity's view permission AND the row exists, is
 * undeleted, and is visible through scope-aware RLS before a link is served.
 */
export function buildEntityLink(
  entityType: string | undefined,
  entityId: string | undefined,
): string | null {
  if (!isSearchEntityType(entityType)) return null;
  if (typeof entityId !== 'string' || !uuidSchema.safeParse(entityId).success) return null;
  // 'person' has no detail page (the users list is the surface); never link.
  if (entityType === 'person') return null;
  const cfg = entityConfig(entityType as SearchEntityType);
  return `${cfg.urlPrefix}/${entityId}`;
}

/** Human label + description per event type, for the bell / center / settings. */
export const EVENT_TYPE_META: Readonly<
  Record<NotificationEventType, { label: string; description: string }>
> = Object.freeze({
  TASK_ASSIGNED: {
    label: 'Task assigned',
    description: 'A task was assigned to you',
  },
  TASK_DUE: {
    label: 'Task due soon',
    description: 'A reminder before a task’s due date',
  },
  TASK_OVERDUE: {
    label: 'Task overdue',
    description: 'A task passed its due date',
  },
  PROJECT_UPDATED: {
    label: 'Project updated',
    description: 'A project you’re involved in changed',
  },
  DEAL_UPDATED: {
    label: 'Deal updated',
    description: 'A deal you’re involved in changed',
  },
  DEAL_STAGE_CHANGED: {
    label: 'Deal stage changed',
    description: 'A deal moved to a new pipeline stage',
  },
  WORKFLOW_SUCCEEDED: {
    label: 'Workflow succeeded',
    description: 'An automation workflow completed',
  },
  WORKFLOW_FAILED: {
    label: 'Workflow failed',
    description: 'An automation workflow failed',
  },
  AUTOMATION_FAILED: {
    label: 'Automation failed',
    description: 'A background automation failed',
  },
  MENTION: {
    label: 'Mention',
    description: 'Someone mentioned you',
  },
  SYSTEM_ALERT: {
    label: 'System alert',
    description: 'An important system announcement',
  },
});

// Compile-time + runtime guard: every one of the 11 event types has metadata.
for (const t of NOTIFICATION_EVENT_TYPES) {
  if (!EVENT_TYPE_META[t]) {
    throw new Error(`notifications-view: missing EVENT_TYPE_META for '${t}'`);
  }
}

/** Compact relative time for list rows ("5m ago", "3h ago", "2d ago"). */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** One stored preference row (what the preferences API accepts/stores). */
export interface StoredPreference {
  eventType: string;
  channel: string;
  enabled: boolean;
}

/** One row of the settings table: the '*' wildcard first, then the 11 types. */
export interface PreferenceRow {
  /** NotificationEventType or '*' (the wildcard). */
  key: string;
  label: string;
  description: string;
  inApp: { enabled: boolean; customized: boolean };
  email: { enabled: boolean; customized: boolean };
}

/**
 * Pure: builds the settings table view model from stored rows + the effective
 * matrix. The wildcard row reflects the stored '*' row (default: enabled);
 * per-type rows reflect the effective matrix (specific > wildcard > default).
 */
export function buildPreferenceViewModel(
  stored: readonly StoredPreference[],
  effective: readonly {
    eventType: string;
    channel: NotificationChannel;
    enabled: boolean;
    customized: boolean;
  }[],
): PreferenceRow[] {
  const cell = (eventType: string, channel: NotificationChannel) => {
    const found = effective.find((e) => e.eventType === eventType && e.channel === channel);
    return { enabled: found?.enabled ?? true, customized: found?.customized ?? false };
  };
  const wildcardStored = (channel: NotificationChannel) =>
    stored.find((s) => s.eventType === '*' && s.channel === channel);

  const rows: PreferenceRow[] = [
    {
      key: '*',
      label: 'All event types',
      description: 'Default for every event type. Specific toggles below override it.',
      inApp: {
        enabled: wildcardStored('in_app')?.enabled ?? true,
        customized: wildcardStored('in_app') !== undefined,
      },
      email: {
        enabled: wildcardStored('email')?.enabled ?? true,
        customized: wildcardStored('email') !== undefined,
      },
    },
  ];
  for (const t of NOTIFICATION_EVENT_TYPES) {
    const meta = EVENT_TYPE_META[t];
    rows.push({
      key: t,
      label: meta.label,
      description: meta.description,
      inApp: cell(t, 'in_app'),
      email: cell(t, 'email'),
    });
  }
  return rows;
}
