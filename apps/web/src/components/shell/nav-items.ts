export type NavSectionItem = {
  label: string;
  href: string;
  permission: string | null;
  section: string | null;
};

/**
 * All application navigation sections in standard rendering order.
 * Desktop sidebar and mobile navigation drawer share this single definition.
 */
export const SECTIONS: readonly NavSectionItem[] = [
  { label: 'Home', href: '/', permission: null, section: null },
  {
    label: 'My security',
    href: '/me/security',
    permission: null,
    section: null,
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
  // Phase 8 (Search & Notifications): the notification center. Deep-linkable
  // and accessible via bell icon or navigation directory.
  {
    label: 'Notifications',
    href: '/notifications',
    permission: 'notifications.view',
    section: null,
  },
  // Phase 5 (Workflow Engine): Automations section.
  { label: 'Workflows', href: '/workflows', permission: 'workflows.view', section: 'Automations' },
  // Phase 6 (Automation & Background Jobs): the /jobs queue dashboard.
  { label: 'Jobs', href: '/jobs', permission: 'jobs.view', section: 'Automations' },
  // Phase 7 (Analytics & Dashboards): the Analytics section.
  { label: 'Overview', href: '/analytics', permission: 'reports.view', section: 'Analytics' },
  { label: 'Sales', href: '/analytics/sales', permission: 'reports.view', section: 'Analytics' },
  { label: 'CRM', href: '/analytics/crm', permission: 'reports.view', section: 'Analytics' },
  { label: 'Work', href: '/analytics/work', permission: 'reports.view', section: 'Analytics' },
  {
    label: 'Automation',
    href: '/analytics/automation',
    permission: 'reports.view',
    section: 'Analytics',
  },
] as const;

export type RenderNavItem =
  { kind: 'header'; section: string } | { kind: 'entry'; label: string; href: string };

/**
 * Filter sections against held permissions and flatten with section headers.
 * Safe to serialize across server/client boundaries.
 */
export function getVisibleNavItems(held: ReadonlySet<string>): RenderNavItem[] {
  const canSeePermissions = held.has('roles.manage') || held.has('users.manage');
  const visible = SECTIONS.filter(
    (s) =>
      s.permission === null ||
      held.has(s.permission) ||
      (s.href === '/admin/permissions' && canSeePermissions),
  );

  const items: RenderNavItem[] = [];
  let lastSection: string | null = null;
  for (const s of visible) {
    if (s.section !== null && s.section !== lastSection) {
      items.push({ kind: 'header', section: s.section });
    }
    lastSection = s.section;
    items.push({ kind: 'entry', label: s.label, href: s.href });
  }
  return items;
}
