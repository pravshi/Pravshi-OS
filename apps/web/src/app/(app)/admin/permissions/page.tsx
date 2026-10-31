import { Badge } from '@/components/ui/badge';
import { getPermissionsPageData } from './actions';

function scopeLabel(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * /admin/permissions — the access review: every permission in the catalogue,
 * what it means, and which roles hold it at which scope. Read-only; grants are
 * changed on /admin/roles. Requires roles.manage or users.manage.
 */
export default async function AdminPermissionsPage() {
  const permissions = await getPermissionsPageData();

  const modules = new Map<string, typeof permissions>();
  for (const p of permissions) {
    const list = modules.get(p.module) ?? [];
    list.push(p);
    modules.set(p.module, list);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Permissions</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The capability catalogue and who holds what. Grants are edited on the Roles page.
        </p>
      </div>

      {[...modules].map(([module, perms]) => (
        <section key={module} className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {module.replace(/_/g, ' ')}
          </h2>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-cream-dark/50 text-left">
                  <th className="px-4 py-2 font-medium">Permission</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium">Held by</th>
                </tr>
              </thead>
              <tbody>
                {perms.map((p) => (
                  <tr key={p.key} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-mono text-xs">{p.key}</span>
                      {p.isSensitive && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          sensitive
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">{p.description ?? '—'}</td>
                    <td className="px-4 py-2">
                      {p.holders.length === 0 ? (
                        <span className="text-ink-muted">No role holds this</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {p.holders.map((h) => (
                            <span
                              key={h.roleCode}
                              className="rounded bg-cream-dark px-1.5 py-0.5 font-mono text-xs"
                              title={`${h.roleName} — ${scopeLabel(h.scope)} scope`}
                            >
                              {h.roleCode} · {scopeLabel(h.scope)}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {permissions.length === 0 && (
        <p className="text-sm text-ink-muted">No permissions in the catalogue.</p>
      )}
    </div>
  );
}
