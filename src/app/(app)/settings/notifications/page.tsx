import { requirePagePermission } from '@/lib/authz/page';
import { getPreferencesPageData } from './actions';
import { PreferencesForm } from '@/components/notifications/PreferencesForm';

/**
 * /settings/notifications — the signed-in user's own notification delivery
 * preferences. notifications.preferences.manage (SELF).
 *
 * Async Server Component: loads the stored + effective preference data;
 * the form is a client component that PUTs single-entry updates to
 * /api/notifications/preferences (contract §16.7).
 */
export default async function NotificationPreferencesPage() {
  await requirePagePermission('notifications.preferences.manage');
  const data = await getPreferencesPageData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notification settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Choose which events notify you, and where. Everything is on by default; turn off what you
          don’t need.
        </p>
      </div>
      <PreferencesForm
        key={JSON.stringify(data.stored)}
        initialStored={data.stored}
        initialEffective={data.effective}
      />
    </div>
  );
}
