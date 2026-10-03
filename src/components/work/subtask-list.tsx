'use client';

import { useState } from 'react';
import { cn } from 'cn';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { Subtask, TaskStatus } from '@/lib/work/schema';
import { createSubtaskAction, setSubtaskStatusAction } from '@/app/(app)/work/subtasks/actions';

/**
 * SubtaskList — the subtask section for a task detail page (Phase 4).
 * Apple-minimal: quiet rows, a hairline divider rhythm, one restrained accent.
 *
 * The UI agent's task detail page owns layout; this component drops in as the
 * subtasks section: <SubtaskList parentTaskId={task.id} initialSubtasks={…} />.
 * Permission gating is by prop — pass canCreate/canToggle=false when the
 * viewer lacks tasks.create/tasks.edit; the forms simply disappear.
 *
 * P0-1 lesson (2026-10-03): this component imports the server actions directly
 * and calls them with arguments — it never receives them as props, so no
 * inline-closure serialization issue can arise.
 */

const PRIORITY_LABEL: Record<Subtask['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * Minimal server-action failure envelope (mirrors the real ErrorEnvelope shape;
 * defined locally because the require-permission-first guard keeps the authz
 * engine out of client components — see tests/guards/require-permission-first).
 */
type ActionErrorEnvelope = { error: { message: string } };

function isErrorEnvelope(value: unknown): value is ActionErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

function envelopeMessage(value: ActionErrorEnvelope): string {
  return value.error.message;
}

function SubtaskRow({
  subtask,
  disabled,
  onToggle,
}: {
  subtask: Subtask;
  disabled: boolean;
  onToggle: (subtask: Subtask) => void;
}) {
  const completed = subtask.status === 'done';
  return (
    <li className="flex items-center gap-3 py-2.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={completed}
        aria-label={completed ? `Reopen ${subtask.title}` : `Complete ${subtask.title}`}
        disabled={disabled}
        onClick={() => onToggle(subtask)}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
          completed
            ? 'border-transparent bg-emerald-500 text-white'
            : 'border-neutral-300 bg-transparent hover:border-neutral-400 dark:border-neutral-600 dark:hover:border-neutral-500',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {completed && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
      </button>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          completed ? 'text-muted-foreground line-through' : 'text-foreground',
        )}
        title={subtask.title}
      >
        {subtask.title}
      </span>
      {subtask.priority !== 'medium' && (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {PRIORITY_LABEL[subtask.priority]}
        </Badge>
      )}
    </li>
  );
}

export function SubtaskList({
  parentTaskId,
  initialSubtasks = [],
  canCreate = true,
  canToggle = true,
}: {
  parentTaskId: string;
  initialSubtasks?: Subtask[];
  canCreate?: boolean;
  canToggle?: boolean;
}) {
  const [subtasks, setSubtasks] = useState<Subtask[]>(initialSubtasks);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completedCount = subtasks.filter((s) => s.status === 'done').length;

  async function handleToggle(subtask: Subtask) {
    if (!canToggle || busy) return;
    const next: TaskStatus = subtask.status === 'done' ? 'todo' : 'done';
    setBusy(true);
    setError(null);
    // Optimistic: flip immediately, roll back if the action fails.
    setSubtasks((prev) => prev.map((s) => (s.id === subtask.id ? { ...s, status: next } : s)));
    const result = await setSubtaskStatusAction(subtask.id, next);
    setBusy(false);
    if (isErrorEnvelope(result)) {
      setSubtasks((prev) =>
        prev.map((s) => (s.id === subtask.id ? { ...s, status: subtask.status } : s)),
      );
      setError(envelopeMessage(result));
    } else {
      const updated: Subtask = result;
      setSubtasks((prev) => prev.map((s) => (s.id === subtask.id ? updated : s)));
    }
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    const result = await createSubtaskAction(parentTaskId, { title });
    setBusy(false);
    if (isErrorEnvelope(result)) {
      setError(envelopeMessage(result));
      return;
    }
    setDraft('');
    const created: Subtask = result;
    setSubtasks((prev) => [...prev, created]);
  }

  return (
    <section aria-label="Subtasks" className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 pt-4 pb-1">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Subtasks</h2>
        <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {subtasks.length === 0 ? 'None yet' : `${completedCount} of ${subtasks.length} done`}
        </span>
      </div>

      {subtasks.length > 0 && (
        <ul className="divide-y divide-border/60 px-5">
          {subtasks.map((subtask) => (
            <SubtaskRow
              key={subtask.id}
              subtask={subtask}
              disabled={!canToggle || busy}
              onToggle={handleToggle}
            />
          ))}
        </ul>
      )}

      {canCreate && (
        <form onSubmit={handleCreate} className="flex items-center gap-2 px-5 py-4">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a subtask…"
            aria-label="New subtask title"
            maxLength={255}
            disabled={busy}
            className="h-9 rounded-xl border-border/80 bg-background"
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy || draft.trim().length === 0}
            className="h-9 shrink-0 rounded-xl px-4"
          >
            Add
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="px-5 pb-4 text-xs text-destructive">
          {error}
        </p>
      )}

      {subtasks.length === 0 && !canCreate && (
        <p className="px-5 pb-4 text-xs text-muted-foreground">No subtasks yet.</p>
      )}
    </section>
  );
}
