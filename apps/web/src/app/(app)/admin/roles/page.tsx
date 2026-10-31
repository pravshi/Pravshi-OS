import { requirePagePermission } from '@/lib/authz/page';
import { getRoleGridData } from './actions';
import { RolesGridClient } from './roles-grid-client';

/**
 * /admin/roles — the editable role × permission grid. Each cell sets the scope
 * (GLOBAL / DEPARTMENT / TEAM / PROJECT / SELF) at which the role holds the
 * permission; clearing a cell removes the grant. Saving a role replaces its
 * whole grant set through set_role_permissions() (migration 0028), which
 * enforces the protected-role rule and the last-holder rail in the database.
 * Requires roles.manage.
 */
export default async function AdminRolesPage() {
  await requirePagePermission('roles.manage');
  const { roles, catalogue } = await getRoleGridData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What each role grants, and how far. Pick a scope per cell, then save the role. Roles
          marked admin carry administrative capability.
        </p>
      </div>

      {roles.length === 0 ? (
        <p className="text-sm text-ink-muted">No roles defined.</p>
      ) : (
        <RolesGridClient roles={roles} catalogue={catalogue} />
      )}
    </div>
  );
}
