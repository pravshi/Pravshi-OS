'use client';

import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { saveRolePermissionsAction } from './actions';
import type { AccessScope, GrantInput } from '@/lib/admin/roles';

type Role = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isProtected: boolean;
  grants: { permissionKey: string; scope: AccessScope }[];
};

type CatalogueEntry = {
  key: string;
  resource: string;
  action: string;
  module: string;
  description: string | null;
  isSensitive: boolean;
};

const SCOPES: AccessScope[] = ['GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF'];

function scopeLabel(s: AccessScope): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function buildBaseline(roles: Role[]): Map<string, Map<string, string>> {
  const m = new Map<string, Map<string, string>>();
  for (const r of roles) {
    const g = new Map<string, string>();
    for (const grant of r.grants) g.set(grant.permissionKey, grant.scope);
    m.set(r.id, g);
  }
  return m;
}

export function RolesGridClient({
  roles,
  catalogue,
}: {
  roles: Role[];
  catalogue: CatalogueEntry[];
}) {
  // roleId -> permissionKey -> scope ('' = no grant)
  const [baseline, setBaseline] = useState<Map<string, Map<string, string>>>(() =>
    buildBaseline(roles),
  );
  const [edits, setEdits] = useState<Map<string, Map<string, string>>>(() => buildBaseline(roles));
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const modules = useMemo(() => {
    const order: string[] = [];
    const byModule = new Map<string, CatalogueEntry[]>();
    for (const p of catalogue) {
      if (!byModule.has(p.module)) {
        byModule.set(p.module, []);
        order.push(p.module);
      }
      byModule.get(p.module)!.push(p);
    }
    return order.map((module) => ({ module, permissions: byModule.get(module)! }));
  }, [catalogue]);

  function setCell(roleId: string, permissionKey: string, scope: string) {
    setEdits((prev) => {
      const next = new Map(prev);
      const roleGrants = new Map(next.get(roleId));
      if (scope === '') roleGrants.delete(permissionKey);
      else roleGrants.set(permissionKey, scope);
      next.set(roleId, roleGrants);
      return next;
    });
    setSavedAt(null);
  }

  function isDirty(roleId: string): boolean {
    const a = baseline.get(roleId)!;
    const b = edits.get(roleId)!;
    if (a.size !== b.size) return true;
    for (const [k, v] of a) if (b.get(k) !== v) return true;
    return false;
  }

  async function onSave(roleId: string) {
    setError(null);
    setSaving(roleId);
    try {
      const grants: GrantInput[] = [...(edits.get(roleId) ?? [])].map(([permissionKey, scope]) => ({
        permissionKey,
        scope: scope as AccessScope,
      }));
      await saveRolePermissionsAction(roleId, grants);
      setBaseline(new Map(edits));
      setSavedAt(roleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the role.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-cream-dark/50">
              <th className="sticky left-0 min-w-56 bg-cream-dark/50 px-4 py-2 text-left font-medium">
                Permission
              </th>
              {roles.map((r) => (
                <th key={r.id} className="min-w-40 px-3 py-2 text-left font-medium">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{r.code}</span>
                    {r.isProtected && (
                      <Badge variant="destructive" className="text-[10px]">
                        admin
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1">
                    <Button
                      variant={isDirty(r.id) ? 'default' : 'outline'}
                      size="sm"
                      disabled={!isDirty(r.id) || saving !== null}
                      onClick={() => onSave(r.id)}
                    >
                      {saving === r.id
                        ? 'Saving…'
                        : savedAt === r.id && !isDirty(r.id)
                          ? 'Saved'
                          : 'Save'}
                    </Button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map(({ module, permissions }) => (
              <Fragment key={`mod-${module}`}>
                <tr className="border-b border-line bg-cream-dark/30">
                  <td
                    colSpan={roles.length + 1}
                    className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted"
                  >
                    {module.replace(/_/g, ' ')}
                  </td>
                </tr>
                {permissions.map((p) => (
                  <tr
                    key={p.key}
                    className="border-b border-line last:border-0 hover:bg-cream-dark/20"
                  >
                    <td className="sticky left-0 bg-background px-4 py-1.5">
                      <span className="font-mono text-xs" title={p.description ?? undefined}>
                        {p.key}
                      </span>
                      {p.isSensitive && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          sensitive
                        </Badge>
                      )}
                    </td>
                    {roles.map((r) => {
                      const value = edits.get(r.id)?.get(p.key) ?? '';
                      return (
                        <td key={r.id} className="px-3 py-1.5">
                          <select
                            aria-label={`${p.key} scope for ${r.code}`}
                            className="w-full rounded border border-line bg-background px-1.5 py-1 text-xs"
                            value={value}
                            disabled={saving !== null}
                            onChange={(e) => setCell(r.id, p.key, e.target.value)}
                          >
                            <option value="">—</option>
                            {SCOPES.map((s) => (
                              <option key={s} value={s}>
                                {scopeLabel(s)}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-muted">
        — means the role does not hold the permission. Saving a role replaces its whole grant set.
        Changes to admin-marked roles, or grants of role management, require roles.manage at global
        scope; the organization always keeps at least one roles.manage holder.
      </p>
    </div>
  );
}
