'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from './empty-state';
import { ErrorMessage } from './error-message';
import { ActivityForm } from './activity-form';
import { ACTIVITY_TYPE_LABELS, formatDateTime } from './format';
import {
  isErrorEnvelope,
  type Activity,
  type ActivityEntityType,
  type CrmResult,
  type ErrorEnvelope,
} from './types';
import { listActivitiesAction, createActivityAction } from '../../app/(app)/crm/actions';

/**
 * Activity timeline for a CRM record detail page (Track B).
 *
 * A client component that fetches its own data through listActivitiesAction —
 * the record's reverse-chronological interaction log (CALL / EMAIL / MEETING /
 * NOTE). The create form is permission-gated: it renders only when canCreate
 * (derived server-side from the held permission set).
 */
export function ActivityTimeline({
  entityType,
  entityId,
  entityName,
  canCreate,
}: {
  entityType: ActivityEntityType;
  entityId: string;
  entityName?: string | null;
  canCreate: boolean;
}) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    const result = await listActivitiesAction({ entityType, entityId, limit: 100 });
    if (isErrorEnvelope(result)) {
      setLoadError(result);
      setActivities([]);
    } else {
      setLoadError(null);
      setActivities(result.rows);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(
    input: Parameters<typeof createActivityAction>[0],
  ): Promise<CrmResult<Activity>> {
    const result = await createActivityAction(input);
    if (!isErrorEnvelope(result)) {
      setShowForm(false);
      await load();
    }
    return result;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">
          Activities{' '}
          {activities !== null && (
            <span className="text-sm text-ink-muted">({activities.length})</span>
          )}
        </h2>
        {canCreate && !showForm && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            Log activity
          </Button>
        )}
      </div>

      {canCreate && showForm && (
        <ActivityForm
          entityType={entityType}
          entityId={entityId}
          entityName={entityName}
          onSave={handleSave}
        />
      )}

      {loadError !== null ? (
        <ErrorMessage error={loadError} title="Could not load activities" />
      ) : activities === null ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-ink-muted">
            Loading activities…
          </CardContent>
        </Card>
      ) : activities.length === 0 ? (
        <EmptyState
          title="No activities yet"
          description="Calls, emails, meetings and notes logged against this record appear here."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timeline</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ol className="divide-y divide-line">
              {activities.map((a) => (
                <li key={a.id} className="flex gap-4 px-4 py-3">
                  <div className="flex w-24 shrink-0 flex-col">
                    <span className="text-xs font-semibold uppercase tracking-wide text-brand">
                      {ACTIVITY_TYPE_LABELS[a.type]}
                    </span>
                    <span className="text-xs text-ink-muted">{formatDateTime(a.occurredAt)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/crm/activities/${a.id}`}
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {a.subject}
                    </Link>
                    {a.notes && (
                      <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{a.notes}</p>
                    )}
                    {a.dueAt && (
                      <p className="mt-1 text-xs text-ink-muted">Due {formatDateTime(a.dueAt)}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
