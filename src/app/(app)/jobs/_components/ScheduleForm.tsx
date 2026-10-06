'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isValidCron, isValidTimezone } from '@/lib/jobs/cron';
import type { ScheduleRow } from '../_jobs';

/** A compact, commonly-needed IANA timezone set for the schedule form. */
export const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
] as const;

const selectClasses =
  'rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CRON_HINTS: { expr: string; label: string }[] = [
  { expr: '0 9 * * 1-5', label: 'Weekdays at 9:00' },
  { expr: '0 9 * * 1', label: 'Mondays at 9:00' },
  { expr: '0 */6 * * *', label: 'Every 6 hours' },
  { expr: '*/15 * * * *', label: 'Every 15 minutes' },
  { expr: '0 0 1 * *', label: 'First of the month' },
];

/**
 * ScheduleForm — create or edit a workflow schedule.
 *
 * Pre-validates cron (5-field) and timezone client-side for fast feedback;
 * the API re-validates server-side. Posts to POST /api/schedules (create)
 * or PATCH /api/schedules/[id] (edit), per contract §4.2.
 */
export function ScheduleForm({
  workflows,
  schedule,
  onDone,
}: {
  /** Workflows the picker can schedule; empty → free-text workflow-id input. */
  workflows: { id: string; name: string }[];
  /** Present → edit mode (PATCH); absent → create mode (POST). */
  schedule?: ScheduleRow;
  /** Called after a successful save (e.g. close the containing dialog). */
  onDone?: () => void;
}) {
  const router = useRouter();
  const editing = schedule !== undefined;
  const [name, setName] = useState(schedule?.name ?? '');
  const [workflowId, setWorkflowId] = useState(schedule?.workflowId ?? workflows[0]?.id ?? '');
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? 'Asia/Kolkata');
  const [isActive, setIsActive] = useState(schedule?.isActive ?? true);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const trimmedName = name.trim();
    if (!trimmedName) return setFormError('Give the schedule a name.');
    if (!UUID.test(workflowId)) return setFormError('Pick a workflow (or enter its id).');
    if (!isValidCron(cron.trim()))
      return setFormError(
        'Cron must be a 5-field expression like “0 9 * * 1-5” (minute hour day month weekday).',
      );
    if (!isValidTimezone(timezone))
      return setFormError('That timezone is not a valid IANA timezone name.');

    setPending(true);
    try {
      const url = editing ? `/api/schedules/${encodeURIComponent(schedule!.id)}` : '/api/schedules';
      // PATCH accepts only { name, cron, timezone, isActive } (strict schema)
      // — the workflow is immutable once a schedule is created.
      const body = editing
        ? { name: trimmedName, cron: cron.trim(), timezone, isActive }
        : {
            name: trimmedName,
            workflowId,
            cron: cron.trim(),
            timezone,
            isActive,
          };
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let serverError: string | undefined;
      try {
        const body = await res.json();
        serverError = typeof body?.error === 'string' ? body.error : undefined;
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) {
        if (res.status === 403 || res.status === 404)
          setFormError('Access changed — you can no longer manage schedules.');
        else setFormError(serverError ?? `Save failed (HTTP ${res.status}). Please try again.`);
        return;
      }
      toast.success(editing ? 'Schedule updated.' : 'Schedule created.');
      onDone?.();
      router.refresh();
    } catch {
      setFormError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Toaster />
      <div className="space-y-1.5">
        <Label htmlFor="schedule-name">Name</Label>
        <Input
          id="schedule-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily pipeline review"
          maxLength={120}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-workflow">Workflow</Label>
        {editing ? (
          <p className="text-sm text-ink-muted">
            The workflow is fixed once a schedule is created.{' '}
            <span className="font-mono text-xs">{schedule?.workflowId}</span>
          </p>
        ) : workflows.length > 0 ? (
          <select
            id="schedule-workflow"
            className={`${selectClasses} w-full`}
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id="schedule-workflow"
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            placeholder="Workflow id (uuid)"
            className="font-mono"
          />
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-cron">Cron (5-field)</Label>
        <Input
          id="schedule-cron"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 9 * * 1-5"
          className="font-mono"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {CRON_HINTS.map((h) => (
            <button
              key={h.expr}
              type="button"
              onClick={() => setCron(h.expr)}
              className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-muted transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {h.expr} · {h.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-timezone">Timezone</Label>
        <select
          id="schedule-timezone"
          className={`${selectClasses} w-full`}
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        >
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="h-4 w-4 rounded border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        Active — the scheduler enqueues runs on this cron
      </label>

      {formError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}

      <Button type="submit" size="sm" disabled={pending}>
        {pending
          ? editing
            ? 'Saving…'
            : 'Creating…'
          : editing
            ? 'Save changes'
            : 'Create schedule'}
      </Button>
    </form>
  );
}
