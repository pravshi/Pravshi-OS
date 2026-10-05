'use client';

import { useState } from 'react';
import {
  ACTION_TYPE_LABELS,
  DEFERRED_ACTION_LABELS,
  DEFERRED_ACTION_TYPES,
  IMPLEMENTED_ACTION_TYPES,
  TRIGGER_TEMPLATE_PATHS,
  type ImplementedTriggerType,
} from './schemas';
// (BuilderAction is the local editable shape; ActionConfig stays server-side.)
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldLabel, FieldError } from '@/components/crm/pickers';

/**
 * The builder edits actions with params as a free-form record — inputs are
 * strings until save, and blanks drop out. The SERVER is the source of
 * truth: CreateWorkflowSchema (via ActionConfigSchema) validates the full
 * payload before any save, so a loose client shape cannot sneak past.
 */
export interface BuilderAction {
  /** Action type string. Loaded drafts may carry a deferred type (the type
   *  select then shows it disabled); the server rejects it at save. */
  type: string;
  params: Record<string, unknown>;
  /** P2-1: reserved — carried through from loaded drafts but no longer
   *  editable in the UI and not consumed by the Phase-5 engine. */
  key?: string;
}

const selectClasses =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

const textareaClasses =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30';

// ── Per-action param forms (mirrors the server param schemas in
//     @/lib/workflows/schema — same fields, same required flags) ─────────────

type FieldInput = 'text' | 'textarea' | 'select' | 'number' | 'date';

interface ActionField {
  name: string;
  label: string;
  input: FieldInput;
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  required?: boolean;
  /** Accepts a concrete id or a {{path}} template resolved at execution. */
  template?: boolean;
  hint?: string;
  /** Smart {{path}} default when the action is added, based on the trigger. */
  defaultTemplate?: (triggerType: string) => string | undefined;
  /**
   * P2-13: when true, a blank input materializes to null instead of being
   * dropped — the only way to clear a nullable field (e.g. task due date)
   * from the builder.
   */
  blankToNull?: boolean;
}

const entityIdTemplate = (triggerType: string) =>
  triggerType === 'manual' ? undefined : '{{event.entityId}}';

const ACTION_FIELDS: Record<string, ActionField[]> = {
  create_task: [
    { name: 'title', label: 'Task title', input: 'text', required: true },
    {
      name: 'projectId',
      label: 'Project id',
      input: 'text',
      template: true,
      hint: 'Optional — the project the task belongs to. Leave empty for no project.',
      defaultTemplate: (t) =>
        t.startsWith('task.')
          ? '{{task.project_id}}'
          : t === 'project.created'
            ? '{{event.entityId}}'
            : undefined,
    },
    { name: 'description', label: 'Description', input: 'textarea' },
    {
      name: 'priority',
      label: 'Priority',
      input: 'select',
      options: ['low', 'medium', 'high', 'urgent'],
    },
    { name: 'assigneePersonId', label: 'Assignee (person id)', input: 'text', template: true },
    { name: 'dueDate', label: 'Due date', input: 'date' },
  ],
  create_project: [
    { name: 'name', label: 'Project name', input: 'text', required: true },
    { name: 'description', label: 'Description', input: 'textarea' },
    {
      name: 'dealId',
      label: 'Link to deal',
      input: 'text',
      template: true,
      hint: 'Deal id to link the new project to.',
      defaultTemplate: (t) => (t.startsWith('deal.') ? '{{event.entityId}}' : undefined),
    },
  ],
  update_deal: [
    {
      name: 'dealId',
      label: 'Deal',
      input: 'text',
      template: true,
      required: true,
      defaultTemplate: entityIdTemplate,
    },
    { name: 'probability', label: 'Probability (0–100)', input: 'number' },
    { name: 'expectedCloseDate', label: 'Expected close date', input: 'date' },
  ],
  update_task: [
    {
      name: 'taskId',
      label: 'Task',
      input: 'text',
      template: true,
      required: true,
      defaultTemplate: entityIdTemplate,
    },
    {
      name: 'status',
      label: 'Status',
      input: 'select',
      options: ['todo', 'in_progress', 'done'],
      optionLabels: { todo: 'To do', in_progress: 'In progress', done: 'Done' },
    },
    {
      name: 'priority',
      label: 'Priority',
      input: 'select',
      options: ['low', 'medium', 'high', 'urgent'],
    },
    {
      name: 'dueDate',
      label: 'Due date',
      input: 'date',
      blankToNull: true,
      hint: 'Clear to remove the due date.',
    },
  ],
  assign_task: [
    {
      name: 'taskId',
      label: 'Task',
      input: 'text',
      template: true,
      required: true,
      defaultTemplate: entityIdTemplate,
    },
    {
      name: 'assigneePersonId',
      label: 'Assignee (person id)',
      input: 'text',
      template: true,
      required: true,
    },
  ],
  link_deal_project: [
    {
      name: 'projectId',
      label: 'Project',
      input: 'text',
      template: true,
      required: true,
      defaultTemplate: (t) => (t === 'project.created' ? '{{event.entityId}}' : undefined),
    },
    {
      name: 'dealId',
      label: 'Deal',
      input: 'text',
      template: true,
      required: true,
      defaultTemplate: (t) => (t.startsWith('deal.') ? '{{event.entityId}}' : undefined),
    },
  ],
};

function defaultForm(type: string, triggerType: string): Record<string, string> {
  const form: Record<string, string> = {};
  for (const field of ACTION_FIELDS[type] ?? []) {
    const templated = field.defaultTemplate?.(triggerType);
    if (templated) form[field.name] = templated;
    else if (field.name === 'priority') form[field.name] = 'medium';
  }
  return form;
}

/** Materialize form strings into action params: blanks dropped (or nulled
 *  for blankToNull fields, P2-13), numbers parsed. */
function materialize(type: string, form: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of ACTION_FIELDS[type] ?? []) {
    const raw = (form[field.name] ?? '').trim();
    if (raw === '') {
      if (field.blankToNull) params[field.name] = null;
      continue;
    }
    params[field.name] = field.input === 'number' ? Number(raw) : raw;
  }
  return params;
}

/** Expand a stored params object back into editable form strings. */
function expandForm(type: string, params: Record<string, unknown>): Record<string, string> {
  const form: Record<string, string> = {};
  for (const field of ACTION_FIELDS[type] ?? []) {
    const value = params[field.name];
    if (value === undefined || value === null) continue;
    form[field.name] = String(value);
  }
  return form;
}

// ── Template hint chips ──────────────────────────────────────────────────────

function TemplateHints({ triggerType }: { triggerType: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const paths = TRIGGER_TEMPLATE_PATHS[triggerType as ImplementedTriggerType] ?? [];
  if (paths.length === 0) return null;

  function copy(path: string) {
    const done = () => {
      setCopied(path);
      window.setTimeout(() => setCopied((c) => (c === path ? null : c)), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(path).then(done).catch(done);
    } else {
      done();
    }
  }

  return (
    <div className="rounded-md border border-dashed border-line p-2.5">
      <p className="text-xs font-medium text-ink-muted">
        Available <code className="text-[11px]">{'{{path}}'}</code> references for this trigger —
        click to copy:
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {paths.map((path) => (
          <button
            key={path}
            type="button"
            onClick={() => copy(path)}
            title={`Copy ${path}`}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-ink-muted transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            {copied === path ? 'copied ✓' : path}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Single action card ───────────────────────────────────────────────────────

function ActionCard({
  index,
  action,
  triggerType,
  isFirst,
  isLast,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  action: BuilderAction;
  triggerType: string;
  isFirst: boolean;
  isLast: boolean;
  onChange: (action: BuilderAction) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const type = action.type;
  const fields = ACTION_FIELDS[type] ?? [];
  const params = (action.params ?? {}) as Record<string, unknown>;
  const form = expandForm(type, params);

  function setForm(next: Record<string, string>) {
    onChange({ ...action, params: materialize(type, next) });
  }

  function pickType(nextType: string) {
    onChange({
      ...action,
      type: nextType,
      params: materialize(nextType, defaultForm(nextType, triggerType)),
    });
  }

  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Step {index + 1}
        </span>
        <select
          aria-label={`Action type for step ${index + 1}`}
          className={`${selectClasses} w-auto flex-1 min-w-40`}
          value={type}
          onChange={(e) => pickType(e.target.value)}
        >
          {IMPLEMENTED_ACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACTION_TYPE_LABELS[t]}
            </option>
          ))}
          {DEFERRED_ACTION_TYPES.map((t) => (
            <option key={t} value={t} disabled>
              {DEFERRED_ACTION_LABELS[t]} (Phase 6+)
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isFirst}
            onClick={() => onMove(-1)}
            aria-label={`Move step ${index + 1} up`}
          >
            ↑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isLast}
            onClick={() => onMove(1)}
            aria-label={`Move step ${index + 1} down`}
          >
            ↓
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove step ${index + 1}`}
          >
            ✕
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `wf-action-${index}-${field.name}`;
          return (
            <div
              key={field.name}
              className={field.input === 'textarea' ? 'sm:col-span-2' : undefined}
            >
              <FieldLabel htmlFor={id}>
                {field.label}
                {field.required ? ' *' : ''}
              </FieldLabel>
              {field.input === 'textarea' ? (
                <textarea
                  id={id}
                  rows={2}
                  className={textareaClasses}
                  value={form[field.name] ?? ''}
                  onChange={(e) => setForm({ ...form, [field.name]: e.target.value })}
                />
              ) : field.input === 'select' ? (
                <select
                  id={id}
                  className={selectClasses}
                  value={form[field.name] ?? ''}
                  onChange={(e) => setForm({ ...form, [field.name]: e.target.value })}
                >
                  <option value="">—</option>
                  {(field.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {field.optionLabels?.[opt] ?? opt}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id={id}
                  type={field.input}
                  className={field.input === 'number' ? 'w-36' : undefined}
                  min={field.input === 'number' ? 0 : undefined}
                  max={field.input === 'number' ? 100 : undefined}
                  value={form[field.name] ?? ''}
                  placeholder={field.template ? 'uuid or {{path}}' : undefined}
                  onChange={(e) => setForm({ ...form, [field.name]: e.target.value })}
                />
              )}
              {field.hint && <p className="mt-1 text-xs text-ink-muted">{field.hint}</p>}
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-3">
        <TemplateHints triggerType={triggerType} />
      </div>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export function ActionBuilder({
  actions,
  onChange,
  triggerType,
  error,
}: {
  actions: BuilderAction[];
  onChange: (actions: BuilderAction[]) => void;
  triggerType: string;
  error?: string;
}) {
  const atLimit = actions.length >= 20;

  function addAction() {
    if (atLimit) return;
    const type = 'create_task';
    onChange([...actions, { type, params: materialize(type, defaultForm(type, triggerType)) }]);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {actions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-6 py-8 text-center">
          <p className="text-sm font-medium">No actions yet</p>
          <p className="mt-1 text-sm text-ink-muted">
            A workflow needs at least one THEN step. Actions run in order — if one fails, the
            remaining steps are skipped and the run is recorded as failed.
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {actions.map((action, i) => (
            <li key={i}>
              <ActionCard
                index={i}
                action={action}
                triggerType={triggerType}
                isFirst={i === 0}
                isLast={i === actions.length - 1}
                onChange={(next) => onChange(actions.map((a, j) => (j === i ? next : a)))}
                onMove={(direction) => move(i, direction)}
                onRemove={() => onChange(actions.filter((_, j) => j !== i))}
              />
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={atLimit} onClick={addAction}>
          + Add action
        </Button>
        {atLimit && (
          <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-300">
            Action limit reached (20 per workflow).
          </p>
        )}
      </div>

      {error && <FieldError message={error} />}
    </div>
  );
}
