import { requirePagePermission } from '@/lib/authz/page';
import { getUsersPageData } from './actions';
import { UsersClient } from './users-client';

/**
 * /admin/users — people with logins, pending invitations, and role assignment.
 * users.view to see; the actions authorize users.create / users.suspend /
 * roles.manage individually.
 */
export default async function AdminUsersPage() {
  await requirePagePermission('users.view');
  const data = await getUsersPageData();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-ink-muted">
          People with logins, pending invitations, and who holds which role.
        </p>
      </div>
      <UsersClient
        users={data.users}
        invitations={data.invitations}
        roles={data.roles}
        departments={data.departments}
      />
    </div>
  );
}
