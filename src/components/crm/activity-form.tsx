'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ActivityFormSchema, type ActivityFormInput } from './schemas';
import { FieldLabel, FieldError } from './pickers';
import {
  isErrorEnvelope,
  ACTIVITY_TYPES,
  ACTIVITY_ENTITY_TYPES,
  type Activity,
  type ActivityEntityType,
  type CrmResult,
} from './types';
import { ACTIVITY_TYPE_LABELS } from './format';

const selectClasses =
  'w-full rounded-md border border-line bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30';

/** ISO instant → the "YYYY-MM-DDTHH:MM" a datetime-local input expects. */
function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Activity create/edit form. The (entityType, entityId) link is fixed for the
 * lifetime of the form — on edit it renders read-only because the link is
 * immutable (migration 0034 / UpdateActivitySchema carry no entity fields).
 * Client-validates, then hands a clean object to the server action; the server
 * re-validates, probes the referenced record for visibility, and stamps
 * ownership (no owner picker is offered — the INSERT rule requires owner = actor).
 */
export function ActivityForm({
  entityType,
  entityId,
  entityName,
  initial,
  onSave,
}: {
  entityType: ActivityEntityType;
  entityId: string;
  entityName?: string | null;
  initial?: Activity;
  onSave: (
    input: ActivityFormInput & { entityType: ActivityEntityType; entityId: string },
  ) => Promise<CrmResult<Activity>>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [values, setValues] = useState({
    type: initial?.type ?? 'NOTE',
    subject: initial?.subject ?? '',
    notes: initial?.notes ?? '',
    occurredAt: toDateTimeLocal(initial?.occurredAt),
    dueAt: toDateTimeLocal(initial?.dueAt),
  });

  function set<K extends keyof typeof values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const parsed = ActivityFormSchema.safeParse(values);
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
      const result = await onSave({ ...parsed.data, entityType, entityId });
      if (isErrorEnvelope(result)) {
        setFormError(result.error.message);
      } else {
        router.push(`/crm/activities/${result.id}`);
        router.refresh();
      }
    } catch {
      setFormError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? 'Edit activity' : 'Log activity'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="text-sm text-ink-muted">
            Linked to {entityType}:{' '}
            <span className="font-medium text-foreground">{entityName ?? entityId}</span>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="activity-type">Type *</FieldLabel>
              <select
                id="activity-type"
                value={values.type}
                onChange={(e) => set('type', e.target.value)}
                disabled={pending}
                className={selectClasses}
              >
                {ACTIVITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACTIVITY_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors.type} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="activity-subject">Subject *</FieldLabel>
              <Input
                id="activity-subject"
                value={values.subject}
                onChange={(e) => set('subject', e.target.value)}
                placeholder="Kickoff call with the team"
                maxLength={255}
                disabled={pending}
              />
              <FieldError message={fieldErrors.subject} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <FieldLabel htmlFor="activity-notes">Notes</FieldLabel>
              <textarea
                id="activity-notes"
                value={values.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="What was discussed, next steps…"
                maxLength={4000}
                rows={4}
                disabled={pending}
                className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
              />
              <FieldError message={fieldErrors.notes} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="activity-occurredAt">Occurred at</FieldLabel>
              <Input
                id="activity-occurredAt"
                type="datetime-local"
                value={values.occurredAt}
                onChange={(e) => set('occurredAt', e.target.value)}
                disabled={pending}
              />
              <FieldError message={fieldErrors.occurredAt} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="activity-dueAt">Due at</FieldLabel>
              <Input
                id="activity-dueAt"
                type="datetime-local"
                value={values.dueAt}
                onChange={(e) => set('dueAt', e.target.value)}
                disabled={pending}
              />
              <FieldError message={fieldErrors.dueAt} />
            </div>
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : initial ? 'Save changes' : 'Log activity'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Standalone create flow for /crm/activities/new: entity pickers first (the
 * type selects which record list is offered), then the shared ActivityForm.
 * Option lists arrive from the server page, where RLS already applied.
 */
export function NewActivityForm({
  companies,
  contacts,
  deals,
  onSave,
}: {
  companies: { id: string; name: string }[];
  contacts: { id: string; name: string }[];
  deals: { id: string; title: string }[];
  onSave: (
    input: ActivityFormInput & { entityType: ActivityEntityType; entityId: string },
  ) => Promise<CrmResult<Activity>>;
}) {
  const [entityType, setEntityType] = useState<ActivityEntityType>('company');
  const [entityId, setEntityId] = useState('');
  const [pickerError, setPickerError] = useState<string | null>(null);

  const options =
    entityType === 'company'
      ? companies.map((c) => ({ id: c.id, label: c.name }))
      : entityType === 'contact'
        ? contacts.map((c) => ({ id: c.id, label: c.name }))
        : deals.map((d) => ({ id: d.id, label: d.title }));

  const entityName = options.find((o) => o.id === entityId)?.label ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Link to</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="activity-entity-type">Record type *</FieldLabel>
              <select
                id="activity-entity-type"
                value={entityType}
                onChange={(e) => {
                  setEntityType(e.target.value as ActivityEntityType);
                  setEntityId('');
                  setPickerError(null);
                }}
                className={selectClasses}
              >
                {ACTIVITY_ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === 'company' ? 'Company' : t === 'contact' ? 'Contact' : 'Deal'}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="activity-entity-id">
                {entityType === 'company'
                  ? 'Company'
                  : entityType === 'contact'
                    ? 'Contact'
                    : 'Deal'}{' '}
                *
              </FieldLabel>
              <select
                id="activity-entity-id"
                value={entityId}
                onChange={(e) => {
                  setEntityId(e.target.value);
                  setPickerError(null);
                }}
                className={selectClasses}
              >
                <option value="">Select…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <FieldError message={pickerError ?? undefined} />
            </div>
          </div>
        </CardContent>
      </Card>

      {entityId ? (
        <ActivityForm
          key={`${entityType}:${entityId}`}
          entityType={entityType}
          entityId={entityId}
          entityName={entityName}
          onSave={onSave}
        />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-ink-muted">
            Pick a {entityType} above to log an activity against it.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
