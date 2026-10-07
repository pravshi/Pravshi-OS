'use client';

/**
 * Phase 8 — Notification preferences form (Workstream E).
 *
 * One row per event type (11) plus the '*' wildcard master row; in_app/email
 * channel toggles per row. Toggles PUT a single-entry update to
 * /api/notifications/preferences (contract §16.7) with optimistic flip and
 * rollback on error, then refetch the authoritative matrix.
 *
 * Toasts are rendered by the <Toaster /> mounted in NotificationBell
 * (app header, always present on (app) pages).
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { getPreferencesPageData } from '@/app/(app)/settings/notifications/actions';
import {
  buildPreferenceViewModel,
  type PreferenceRow,
  type StoredPreference,
} from './notifications-view';
import type { EffectivePreference } from '@/lib/notifications/preferences';
import type { NotificationChannel } from '@/lib/notifications/types';

type CellState = { enabled: boolean; customized: boolean };
type RowState = PreferenceRow & { busy: boolean };

function toRowState(rows: PreferenceRow[]): RowState[] {
  return rows.map((r) => ({ ...r, busy: false }));
}

export function PreferencesForm({
  initialStored,
  initialEffective,
}: {
  initialStored: StoredPreference[];
  initialEffective: EffectivePreference[];
}) {
  const [rows, setRows] = useState<RowState[]>(() =>
    toRowState(buildPreferenceViewModel(initialStored, initialEffective)),
  );

  const setCell = (key: string, channel: NotificationChannel, cell: Partial<CellState>) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const slot = channel === 'in_app' ? 'inApp' : 'email';
        return { ...r, [slot]: { ...r[slot], ...cell } };
      }),
    );
  const setBusy = (key: string, busy: boolean) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, busy } : r)));

  const toggle = async (row: RowState, channel: NotificationChannel) => {
    if (row.busy) return;
    const slot = channel === 'in_app' ? 'inApp' : 'email';
    const next = !row[slot].enabled;
    // Optimistic flip; the refetch after PUT corrects wildcard interactions.
    const previousCell = { ...row[slot] };
    setCell(row.key, channel, { enabled: next, customized: true });
    setBusy(row.key, true);
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preferences: [{ eventType: row.key, channel, enabled: next }],
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail as { message?: string } | null)?.message ?? `Request failed (${res.status})`,
        );
      }
      // Authoritative state: recompute from stored + effective.
      const data = await getPreferencesPageData();
      setRows(toRowState(buildPreferenceViewModel(data.stored, data.effective)));
    } catch (error) {
      // Rollback.
      setCell(row.key, channel, previousCell);
      toast.error('Could not save preference', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setBusy(row.key, false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-cream-dark/50 text-left">
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="w-36 px-4 py-2 font-medium">In-app</th>
              <th className="w-36 px-4 py-2 font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-line last:border-0">
                <td className="px-4 py-3">
                  <p className="font-medium">{row.label}</p>
                  <p className="text-xs text-ink-muted">{row.description}</p>
                </td>
                {(['inApp', 'email'] as const).map((slot) => {
                  const channel: NotificationChannel = slot === 'inApp' ? 'in_app' : 'email';
                  const cell = row[slot];
                  return (
                    <td key={slot} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ChannelSwitch
                          checked={cell.enabled}
                          disabled={row.busy}
                          label={`${row.label} via ${slot === 'inApp' ? 'in-app' : 'email'}`}
                          onToggle={() => void toggle(row, channel)}
                        />
                        <span className="text-xs text-ink-muted">
                          {cell.customized ? 'Custom' : 'Default'}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-muted">
        “Default” means you haven’t changed it — the event notifies you. “Custom” means you overrode
        it. The “All event types” row sets the default for every event; a specific event’s toggle
        always wins over it.
      </p>
    </div>
  );
}

/** Accessible toggle switch (button with role="switch"). */
function ChannelSwitch({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-ink-muted/30',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}
