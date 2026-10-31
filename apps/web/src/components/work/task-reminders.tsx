'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type TaskReminder = {
  id: string;
  taskId: string;
  personId: string;
  remindAt: string;
  isSent: boolean;
  createdAt: string;
};

type Props = {
  /** The task these reminders belong to. */
  taskId: string;
  /**
   * Whether the viewer may set reminders: true when they are the task's
   * assignee or creator. The server re-checks this; this only gates the UI.
   */
  canSet: boolean;
};

function formatLocal(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * TaskReminders — Apple-minimal reminder picker for the task detail page
 * (Phase 4 V1). datetime-local input + list of the viewer's own reminders.
 * Delivery is out of scope: reminders are stored only.
 *
 * Integration (task detail page, server):
 *   import { TaskReminders } from '@/components/work/task-reminders';
 *   …
 *   const canSetReminders =
 *     task.assigneePersonId === currentPersonId || task.createdBy === currentPersonId;
 *   <TaskReminders taskId={task.id} canSet={canSetReminders} />
 */
export function TaskReminders({ taskId, canSet }: Props) {
  const [reminders, setReminders] = useState<TaskReminder[]>([]);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/work/tasks/${taskId}/reminders`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Could not load reminders');
      setReminders((await res.json()) as TaskReminder[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load reminders');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addReminder() {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      const remindAt = new Date(value).toISOString();
      const res = await fetch(`/api/work/tasks/${taskId}/reminders`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remindAt }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? 'Could not set reminder');
      setValue('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set reminder');
    } finally {
      setSaving(false);
    }
  }

  async function removeReminder(reminderId: string) {
    setDeletingId(reminderId);
    setError(null);
    try {
      const res = await fetch(`/api/work/tasks/${taskId}/reminders/${reminderId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Could not remove reminder');
      setReminders((prev) => prev.filter((r) => r.id !== reminderId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove reminder');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reminders</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canSet && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-44">
              <Input
                type="datetime-local"
                aria-label="Reminder date and time"
                value={value}
                min={new Date().toISOString().slice(0, 16)}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={addReminder} disabled={!value || saving}>
              {saving ? 'Adding…' : 'Add reminder'}
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <div className="space-y-2" aria-label="Loading reminders">
            <div className="h-4 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          </div>
        ) : reminders.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {canSet ? 'No reminders set. Pick a date and time above.' : 'No reminders set.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {reminders.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span
                  className={cn(
                    'text-sm',
                    new Date(r.remindAt).getTime() < Date.now() && 'text-ink-muted line-through',
                  )}
                >
                  {formatLocal(r.remindAt)}
                </span>
                {canSet && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-ink-muted hover:text-destructive"
                    onClick={() => removeReminder(r.id)}
                    disabled={deletingId === r.id}
                    aria-label={`Remove reminder ${formatLocal(r.remindAt)}`}
                  >
                    {deletingId === r.id ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
