import Link from 'next/link';
import { heldNavPermissions } from '@/lib/authz/nav';

/**
 * Permission-filtered navigation. A section renders only when the viewer holds a
 * permission inside it — checked via heldNavPermissions(), which reads authz.has()
 * without auditing (nav rendering is not an authorization decision). Every target
 * page still enforces its own requirePagePermission().
 */
const SECTIONS = [
  { label: 'Home', href: '/', permission: null as string | null },
  { label: 'My security', href: '/me/security', permission: null as string | null },
  { label: 'Users', href: '/admin/users', permission: 'users.view' },
  { label: 'Roles', href: '/admin/roles', permission: 'roles.manage' },
  { label: 'Permissions', href: '/admin/permissions', permission: 'roles.manage' },
  { label: 'Teams', href: '/admin/teams', permission: 'teams.view' },
  { label: 'Departments', href: '/admin/departments', permission: 'departments.view' },
  { label: 'Audit logs', href: '/admin/audit-logs', permission: 'audit_logs.view' },
] as const;

export async function Sidebar() {
  const held = await heldNavPermissions();
  // The Permissions page answers roles.manage OR users.manage.
  const canSeePermissions = held.has('roles.manage') || held.has('users.manage');
  const visible = SECTIONS.filter(
    (s) =>
      s.permission === null ||
      held.has(s.permission) ||
      (s.href === '/admin/permissions' && canSeePermissions),
  );

  return (
    <nav className="hidden border-r border-rule bg-surface p-4 md:block" aria-label="Main">
      <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-brand">PRAVSHI</div>
      <ul className="flex flex-col gap-1">
        {visible.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block rounded px-3 py-2 text-sm hover:bg-brand-soft">
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
