import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorMessage } from '@/components/crm/error-message';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import { EditableSection } from '@/components/crm/editable-section';
import { DeleteDialog } from '@/components/crm/delete-dialog';
import { ActivityForm } from '@/components/crm/activity-form';
import { isErrorEnvelope, type ActivityEntityType } from '@/components/crm/types';
import { ACTIVITY_TYPE_LABELS, formatDateTime } from '@/components/crm/format';
import { getActivityAction, updateActivityAction, deleteActivityAction } from '../../actions';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../../_permissions';

const ENTITY_HREF: Record<ActivityEntityType, (id: string) => string> = {
  company: (id) => `/crm/companies/${id}`,
  contact: (id) => `/crm/contacts/${id}`,
  deal: (id) => `/crm/deals/${id}`,
};

const ENTITY_LABEL: Record<ActivityEntityType, string> = {
  company: 'Company',
  contact: 'Contact',
  deal: 'Deal',
};

/** /crm/activities/[id] — activity detail with edit form and soft delete. */
export default async function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCrmPagePermission('activities', 'view');
  const { id } = await params;

  const [activityRes, held] = await Promise.all([getActivityAction(id), getCrmPermissions()]);

  if (isErrorEnvelope(activityRes)) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorMessage error={activityRes} title="Could not load activity" />
      </div>
    );
  }

  const activity = activityRes;
  const perms = uiPermissionsFor(held, 'activities');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <BackLink />
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{activity.subject}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {ACTIVITY_TYPE_LABELS[activity.type]} activity detail
          </p>
        </div>
        {perms.canDelete && (
          <DeleteDialog
            resourceName="activity"
            recordName={activity.subject}
            onDelete={deleteActivityAction.bind(null, activity.id)}
            redirectTo="/crm/activities"
          />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-line">
            <DetailField label="Type">{ACTIVITY_TYPE_LABELS[activity.type]}</DetailField>
            <DetailField label="Subject">{activity.subject}</DetailField>
            <DetailField label="Notes">{activity.notes ?? '—'}</DetailField>
            <DetailField label="Linked to">
              {ENTITY_LABEL[activity.entityType]}:{' '}
              <DetailLink href={ENTITY_HREF[activity.entityType](activity.entityId)}>
                {activity.entityName ?? activity.entityId}
              </DetailLink>
            </DetailField>
            <DetailField label="Occurred">{formatDateTime(activity.occurredAt)}</DetailField>
            <DetailField label="Due">{formatDateTime(activity.dueAt)}</DetailField>
            <DetailField label="Created">{formatDateTime(activity.createdAt)}</DetailField>
            <DetailField label="Updated">{formatDateTime(activity.updatedAt)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      {perms.canEdit && (
        <EditableSection buttonLabel="Edit activity">
          <ActivityForm
            initial={activity}
            entityType={activity.entityType}
            entityId={activity.entityId}
            entityName={activity.entityName}
            // The (entityType, entityId) link is immutable: UpdateActivitySchema is
            // non-strict zod, so it strips those keys from the input at the
            // parse boundary. A bound server-action reference is serializable;
            // the inline closure this replaces 500'd the page under RSC.
            onSave={updateActivityAction.bind(null, activity.id)}
          />
        </EditableSection>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/crm/activities" className="text-sm text-ink-muted hover:text-foreground">
      ← All activities
    </Link>
  );
}
