import { ErrorMessage } from '@/components/crm/error-message';
import { ActivitiesList } from '@/components/crm/activities-client';
import { isErrorEnvelope, ACTIVITY_TYPES, type ActivityType } from '@/components/crm/types';
import { listActivitiesAction } from '../actions';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../_permissions';

const PAGE_SIZE = 25;

/** /crm/activities — searchable, type-filtered activity list. activities.view to see. */
export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}) {
  await requireCrmPagePermission('activities', 'view');
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const type: ActivityType | null = ACTIVITY_TYPES.includes(params.type as ActivityType)
    ? (params.type as ActivityType)
    : null;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [result, held] = await Promise.all([
    listActivitiesAction({
      search: q === '' ? undefined : q,
      type: type ?? undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getCrmPermissions(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activities</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Calls, emails, meetings and notes across the CRM.
        </p>
      </div>
      {isErrorEnvelope(result) ? (
        <ErrorMessage error={result} title="Could not load activities" />
      ) : (
        <ActivitiesList
          data={result}
          initialQuery={q}
          initialType={type}
          page={page}
          perms={uiPermissionsFor(held, 'activities')}
        />
      )}
    </div>
  );
}
