'use client';

import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldLabel, FieldError } from '@/components/crm/pickers';
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isErrorEnvelope,
  type PersonOption,
  type TaskPriority,
  type TaskStatus,
  type WorkResult,
  type WorkTask,
} from '../_types';

export interface TaskFormInput {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  /** Only sent on create — tasks stay in their project afterwards. */
  projectId?: string;
  assigneePersonId: string | null;
}

const TaskFormSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
  description: z.string().trim().max(4000, 'Description is too long').optional(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date')
    .optional()
    .or(z.literal('')),
  projectId: z.string().uuid('Choose a project').optional().or(z.literal('')),
  assigneePersonId: z.string().uuid('Choose a valid person').optional().or(z.literal('')),
});

const selectClasses =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

const textareaClasses =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30';

/**
 * Task create/edit form. The server action arrives as `onSave` (bound with
 * `.bind(null, id)` for edits — never an inline closure); the API validates
 * authoritatively, this schema only catches typos early.
 */
export function TaskForm({
  initial,
  fixedProjectId,
  projects,
  assignees,
  canAssign,
  onSave,
  onSaved,
  submitLabel,
}: {
  initial?: WorkTask;
  /** When set, the project picker is hidden and this id is always sent. */
  fixedProjectId?: string;
  projects?: { id: string; name: string }[];
  assignees: PersonOption[];
  canAssign: boolean;
  onSave: (input: TaskFormInput) => Promise<WorkResult<WorkTask>>;
  onSaved?: (task: WorkTask) => void;
  submitLabel?: string;
}) {
  const isEdit = Boolean(initial);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [values, setValues] = useState({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    status: initial?.status ?? 'todo',
    priority: initial?.priority ?? 'medium',
    dueDate: initial?.dueDate?.slice(0, 10) ?? '',
    projectId: fixedProjectId ?? initial?.projectId ?? '',
    assigneePersonId: initial?.assigneePersonId ?? '',
  });

  function set<K extends keyof typeof values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  // The current assignee may not be in the visible-people options (they are
  // derived from tasks the viewer can see); keep them selectable anyway.
  const assigneeOptions: PersonOption[] =
    initial?.assigneePersonId &&
    initial.assigneeName &&
    !assignees.some((a) => a.id === initial.assigneePersonId)
      ? [...assignees, { id: initial.assigneePersonId, displayName: initial.assigneeName }]
      : assignees;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const parsed = TaskFormSchema.safeParse(values);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.');
          if (path && !errors[path]) errors[path] = issue.message;
        }
        setFieldErrors(errors);
        setFormError('Please fix the highlighted fields.');
        return;
      }
      const description = parsed.data.description?.trim() ? parsed.data.description.trim() : null;
      const input: TaskFormInput = {
        title: parsed.data.title.trim(),
        description,
        status: parsed.data.status,
        priority: parsed.data.priority,
        dueDate: parsed.data.dueDate ? parsed.data.dueDate : null,
        assigneePersonId: parsed.data.assigneePersonId ? parsed.data.assigneePersonId : null,
      };
      if (!isEdit) input.projectId = fixedProjectId ?? parsed.data.projectId;
      const result = await onSave(input);
      if (isErrorEnvelope(result)) {
        setFormError(result.error.message);
      } else {
        onSaved?.(result);
      }
    } catch {
      setFormError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="task-title">Title</FieldLabel>
        <Input
          id="task-title"
          value={values.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="What needs to be done"
          maxLength={200}
          disabled={pending}
          aria-invalid={Boolean(fieldErrors.title)}
        />
        <FieldError message={fieldErrors.title} />
      </div>

      <div className="space-y-1.5">
        <FieldLabel htmlFor="task-description">Description</FieldLabel>
        <textarea
          id="task-description"
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Details, acceptance criteria, links…"
          maxLength={4000}
          rows={4}
          disabled={pending}
          className={textareaClasses}
          aria-invalid={Boolean(fieldErrors.description)}
        />
        <FieldError message={fieldErrors.description} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="task-status">Status</FieldLabel>
          <select
            id="task-status"
            value={values.status}
            onChange={(e) => set('status', e.target.value)}
            disabled={pending}
            className={selectClasses}
          >
            {TASK_STATUSES.map((s: TaskStatus) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.status} />
        </div>

        <div className="space-y-1.5">
          <FieldLabel htmlFor="task-priority">Priority</FieldLabel>
          <select
            id="task-priority"
            value={values.priority}
            onChange={(e) => set('priority', e.target.value)}
            disabled={pending}
            className={selectClasses}
          >
            {TASK_PRIORITIES.map((p: TaskPriority) => (
              <option key={p} value={p}>
                {TASK_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.priority} />
        </div>

        <div className="space-y-1.5">
          <FieldLabel htmlFor="task-due-date">Due date</FieldLabel>
          <Input
            id="task-due-date"
            type="date"
            value={values.dueDate}
            onChange={(e) => set('dueDate', e.target.value)}
            disabled={pending}
            aria-invalid={Boolean(fieldErrors.dueDate)}
          />
          <FieldError message={fieldErrors.dueDate} />
        </div>

        <div className="space-y-1.5">
          <FieldLabel htmlFor="task-assignee">Assignee</FieldLabel>
          <select
            id="task-assignee"
            value={values.assigneePersonId}
            onChange={(e) => set('assigneePersonId', e.target.value)}
            disabled={pending || !canAssign}
            title={canAssign ? undefined : 'You do not hold tasks.assign'}
            className={selectClasses}
          >
            <option value="">Unassigned</option>
            {assigneeOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.assigneePersonId} />
          {!canAssign && (
            <p className="text-xs text-ink-muted">You can view assignees but not change them.</p>
          )}
        </div>
      </div>

      {!isEdit && !fixedProjectId && (
        <div className="space-y-1.5">
          <FieldLabel htmlFor="task-project">Project</FieldLabel>
          <select
            id="task-project"
            value={values.projectId}
            onChange={(e) => set('projectId', e.target.value)}
            disabled={pending}
            className={selectClasses}
            aria-invalid={Boolean(fieldErrors.projectId)}
          >
            <option value="">Choose a project</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.projectId} />
        </div>
      )}

      {formError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : (submitLabel ?? (isEdit ? 'Save changes' : 'Create task'))}
        </Button>
      </div>
    </form>
  );
}
