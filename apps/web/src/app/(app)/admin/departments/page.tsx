import { requirePagePermission } from '@/lib/authz/page';
import { getDepartmentsPageData } from './actions';
import { DepartmentsClient } from './departments-client';

/** /admin/departments — the org structure. departments.view to see, departments.manage to change. */
export default async function AdminDepartmentsPage() {
  await requirePagePermission('departments.view');
  const departments = await getDepartmentsPageData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Departments</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The organization structure. Member counts come from live engagements.
        </p>
      </div>
      <DepartmentsClient departments={departments} />
    </div>
  );
}
