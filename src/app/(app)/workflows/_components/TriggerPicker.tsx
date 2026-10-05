'use client';

import {
  DEFERRED_TRIGGER_LABELS,
  DEFERRED_TRIGGER_TYPES,
  IMPLEMENTED_TRIGGER_TYPES,
  TASK_STATUS_OPTION_LABELS,
  TASK_STATUS_OPTIONS,
  TRIGGER_TYPE_LABELS,
  suggestedEntityType,
  type ImplementedTriggerType,
} from './schemas';
import type { TriggerConfig } from '@/lib/workflows/schema';
import { FieldLabel, FieldError } from '@/components/crm/pickers';

const selectClasses =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

const checkboxClasses =
  'h-4 w-4 rounded border-line accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

/**
 * WHEN step of the workflow builder: trigger type picker (implemented types
 * enabled; deferred types shown disabled with a "Phase 6+" hint), entity
 * narrowing, and filter inputs evaluated with EQUALS semantics against the
 * event payload (engine's doesTriggerMatch).
 */
export function TriggerPicker({
  value,
  onChange,
  error,
}: {
  value: TriggerConfig;
  onChange: (trigger: TriggerConfig) => void;
  error?: string;
}) {
  const type = value.type as ImplementedTriggerType;

  function pickTriggerType(nextType: string) {
    onChange({
      type: nextType as TriggerConfig['type'],
      entityType: suggestedEntityType(nextType),
      filters: undefined,
    });
  }

  function setFilters(next: Record<string, unknown> | undefined) {
    const filters = next && Object.keys(next).length > 0 ? next : undefined;
    onChange({ ...value, filters });
  }

  function togglePayloadFilter(key: 'isWon' | 'isLost', on: boolean) {
    const filters: Record<string, unknown> = { ...(value.filters ?? {}) };
    if (on) filters[key] = true;
    else delete filters[key];
    setFilters(filters);
  }

  const filters = value.filters ?? {};
  const isDealTrigger = type.startsWith('deal.');
  const isTaskStatusTrigger = type === 'task.status_changed';

  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">Trigger (WHEN)</legend>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="wf-trigger-type">Trigger event</FieldLabel>
          <select
            id="wf-trigger-type"
            aria-label="Trigger event"
            className={selectClasses}
            value={type}
            onChange={(e) => pickTriggerType(e.target.value)}
          >
            {IMPLEMENTED_TRIGGER_TYPES.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_TYPE_LABELS[t]}
              </option>
            ))}
            {DEFERRED_TRIGGER_TYPES.map((t) => (
              <option key={t} value={t} disabled>
                {DEFERRED_TRIGGER_LABELS[t]} (Phase 6+)
              </option>
            ))}
          </select>
        </div>

        <div>
          <FieldLabel htmlFor="wf-trigger-entity">Narrow to entity</FieldLabel>
          <select
            id="wf-trigger-entity"
            aria-label="Narrow to entity"
            className={selectClasses}
            value={value.entityType ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                entityType:
                  e.target.value === ''
                    ? undefined
                    : (e.target.value as 'deal' | 'task' | 'project'),
              })
            }
          >
            <option value="">Auto (match the event&apos;s entity)</option>
            <option value="deal">Deal</option>
            <option value="task">Task</option>
            <option value="project">Project</option>
          </select>
        </div>
      </div>

      {isDealTrigger && (
        <div className="space-y-2 rounded-md border border-line bg-muted/40 p-3">
          <p className="text-xs font-medium text-ink-muted">
            Fire only when…{' '}
            <span className="font-normal">
              (leave off to run for every {TRIGGER_TYPE_LABELS[type].toLowerCase()} event)
            </span>
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={checkboxClasses}
              checked={filters.isWon === true}
              onChange={(e) => togglePayloadFilter('isWon', e.target.checked)}
            />
            the deal is won
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={checkboxClasses}
              checked={filters.isLost === true}
              onChange={(e) => togglePayloadFilter('isLost', e.target.checked)}
            />
            the deal is lost
          </label>
        </div>
      )}

      {isTaskStatusTrigger && (
        <div className="rounded-md border border-line bg-muted/40 p-3">
          <FieldLabel htmlFor="wf-trigger-to-status">Fire only when the new status is</FieldLabel>
          <select
            id="wf-trigger-to-status"
            aria-label="Fire only when the new status is"
            className={selectClasses}
            value={typeof filters.toStatus === 'string' ? filters.toStatus : ''}
            onChange={(e) =>
              setFilters(
                e.target.value === ''
                  ? undefined
                  : { ...(filters as Record<string, unknown>), toStatus: e.target.value },
              )
            }
          >
            <option value="">Any status</option>
            {TASK_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_OPTION_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <FieldError message={error} />}
    </fieldset>
  );
}
