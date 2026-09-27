import { requirePagePermission } from '@/lib/authz/page';
import { getRolesPageData } from './actions';

/**
 * /admin/roles — the role catalogue: every role, what it grants, who holds it.
 * Read-only here; assignment happens on /admin/users (roles.manage).
 */
export default async function AdminRolesPage() {
  await requirePagePermission('roles.view');
  const roles = await getRolesPageData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What each role grants. Roles marked admin carry administrative capability and can only be
          assigned by a global roles manager.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {roles.map((r) => (
          <div key={r.id} className="rounded-lg border border-line bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">
                {r.code}
                {r.isProtected && (
                  <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                    admin
                  </span>
                )}
              </h2>
              <span className="text-xs text-ink-muted">
                {r.holderCount} holder{r.holderCount === 1 ? '' : 's'}
              </span>
            </div>
            {r.description && <p className="mt-1 text-sm text-ink-muted">{r.description}</p>}
            <div className="mt-3 flex flex-wrap gap-1">
              {r.permissions.map((p) => (
                <span key={p} className="rounded bg-cream-dark px-1.5 py-0.5 font-mono text-xs">
                  {p}
                </span>
              ))}
            </div>
          </div>
        ))}
        {roles.length === 0 && <p className="text-sm text-ink-muted">No roles defined.</p>}
      </div>
    </div>
  );
}
