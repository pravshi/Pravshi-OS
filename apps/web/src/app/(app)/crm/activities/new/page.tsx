import { NewActivityForm } from '@/components/crm/activity-form';
import { contactDisplayName, isErrorEnvelope, type CrmResult } from '@/components/crm/types';
import type { Page } from '@/lib/crm/schema';
import {
  createActivityAction,
  listCompaniesAction,
  listContactsAction,
  listDealsAction,
} from '../../actions';
import { requireCrmPagePermission } from '../../_permissions';
import { ErrorMessage } from '@/components/crm/error-message';

/** Unwrap a list result into rows; an error envelope becomes an empty list. */
function rowsOf<T>(result: CrmResult<Page<T>>): T[] {
  return isErrorEnvelope(result) ? [] : result.rows;
}

/**
 * /crm/activities/new — log an activity. activities.create to use.
 * The user picks the record type and record first; the shared ActivityForm
 * then collects the activity itself. You become the owner of every activity
 * you log (the INSERT rule requires owner = actor).
 */
export default async function NewActivityPage() {
  await requireCrmPagePermission('activities', 'create');

  const [companiesRes, contactsRes, dealsRes] = await Promise.all([
    listCompaniesAction({ limit: 100 }),
    listContactsAction({ limit: 100 }),
    listDealsAction({ limit: 100 }),
  ]);

  const firstError = [companiesRes, contactsRes, dealsRes].find((r) => isErrorEnvelope(r));
  if (firstError) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Log activity</h1>
        </div>
        <ErrorMessage error={firstError} title="Could not load records" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Log activity</h1>
        <p className="mt-1 text-sm text-ink-muted">
          You become the owner of every activity you log.
        </p>
      </div>
      <NewActivityForm
        companies={rowsOf(companiesRes).map((c) => ({ id: c.id, name: c.name }))}
        contacts={rowsOf(contactsRes).map((c) => ({ id: c.id, name: contactDisplayName(c) }))}
        deals={rowsOf(dealsRes).map((d) => ({ id: d.id, title: d.title }))}
        onSave={createActivityAction}
      />
    </div>
  );
}
