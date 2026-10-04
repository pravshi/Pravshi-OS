import Link from 'next/link';
import { heldNavPermissions } from '@/lib/authz/nav';

/**
 * Permission-filtered navigation. A section renders only when the viewer holds a
 * permission inside it — checked via heldNavPermissions(), which reads authz.has()
 * without auditing (nav rendering is not an authorization decision). Every target
 * page still enforces its own requirePagePermission().
 */
const SECTIONS = [
  { label: 'Home', href: '/', permission: null as string | null, section: null as string | null },
  {
    label: 'My security',
    href: '/me/security',
    permission: null as string | null,
    section: null as string | null,
  },
  { label: 'Users', href: '/admin/users', permission: 'users.view', section: null },
  { label: 'Roles', href: '/admin/roles', permission: 'roles.manage', section: null },
  {
    label: 'Permissions',
    href: '/admin/permissions',
    permission: 'roles.manage',
    section: null,
  },
  { label: 'Teams', href: '/admin/teams', permission: 'teams.view', section: null },
  {
    label: 'Departments',
    href: '/admin/departments',
    permission: 'departments.view',
    section: null,
  },
  { label: 'Audit logs', href: '/admin/audit-logs', permission: 'audit_logs.view', section: null },
  { label: 'Companies', href: '/crm/companies', permission: 'companies.view', section: null },
  { label: 'Contacts', href: '/crm/contacts', permission: 'contacts.view', section: null },
  { label: 'Deals', href: '/crm/deals', permission: 'deals.view', section: null },
  { label: 'Pipelines', href: '/crm/pipelines', permission: 'pipelines.view', section: null },
  {
    label: 'Activities',
    href: '/crm/activities',
    permission: 'activities.view',
    section: null,
  },
  { label: 'Work', href: '/work', permission: 'projects.view', section: null },
  { label: 'My tasks', href: '/work/my-tasks', permission: 'tasks.view', section: null },
  // Phase 5 (Workflow Engine): the Automations section (future-proof for
  // Phase 6). Desktop-primary: the mobile tab bar keeps its 4 hardcoded tabs
  // (§15), so this entry never surfaces on mobile. /workflows is still
  // deep-linkable.
  { label: 'Workflows', href: '/workflows', permission: 'workflows.view', section: 'Automations' },
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

  // Flatten to render items, injecting a section header the first time each
  // named section appears (P2-11: the Automations section).
  const items: (
    { kind: 'header'; section: string } | { kind: 'entry'; entry: (typeof visible)[number] }
  )[] = [];
  let lastSection: string | null = null;
  for (const s of visible) {
    if (s.section !== null && s.section !== lastSection) {
      items.push({ kind: 'header', section: s.section });
    }
    lastSection = s.section;
    items.push({ kind: 'entry', entry: s });
  }

  return (
    <nav className="hidden border-r border-rule bg-surface p-4 md:block" aria-label="Main">
      <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-brand">PRAVSHI</div>
      <ul className="flex flex-col gap-1">
        {items.map((item) =>
          item.kind === 'header' ? (
            <li
              key={`section-${item.section}`}
              aria-hidden="true"
              className="mt-4 px-3 text-[11px] font-semibold uppercase tracking-widest text-ink-muted first:mt-0"
            >
              {item.section}
            </li>
          ) : (
            <li key={item.entry.href}>
              <Link
                href={item.entry.href}
                className="block rounded px-3 py-2 text-sm hover:bg-brand-soft"
              >
                {item.entry.label}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
