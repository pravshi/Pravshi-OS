import { describe, expect, it } from 'vitest';
import { getVisibleNavItems, SECTIONS, type RenderNavItem } from '@/components/shell/nav-items';

type NavEntry = Extract<RenderNavItem, { kind: 'entry' }>;
type NavHeader = Extract<RenderNavItem, { kind: 'header' }>;

const isEntry = (item: RenderNavItem): item is NavEntry => item.kind === 'entry';
const isHeader = (item: RenderNavItem): item is NavHeader => item.kind === 'header';

describe('Navigation items and permission filtering (UI-02)', () => {
  it('exposes only public/self-service items when no permissions are held', () => {
    const items = getVisibleNavItems(new Set());
    const labels = items.filter(isEntry).map((e) => e.label);

    expect(labels).toEqual(['Home', 'My security']);
    // Ensure no admin, CRM, work, analytics or automation items are exposed
    expect(labels).not.toContain('Users');
    expect(labels).not.toContain('Roles');
    expect(labels).not.toContain('Companies');
    expect(labels).not.toContain('Work');
    expect(labels).not.toContain('Workflows');
    expect(labels).not.toContain('Overview');
  });

  it('exposes permissions page when viewer holds either roles.manage or users.manage', () => {
    const withRoles = getVisibleNavItems(new Set(['roles.manage']));
    const withUsers = getVisibleNavItems(new Set(['users.manage']));
    const withoutEither = getVisibleNavItems(new Set(['users.view']));

    const labelsRoles = withRoles.filter(isEntry).map((e) => e.label);
    const labelsUsers = withUsers.filter(isEntry).map((e) => e.label);
    const labelsNone = withoutEither.filter(isEntry).map((e) => e.label);

    expect(labelsRoles).toContain('Permissions');
    expect(labelsUsers).toContain('Permissions');
    expect(labelsNone).not.toContain('Permissions');
  });

  it('injects section headers only when child items in that section are visible', () => {
    const noReports = getVisibleNavItems(new Set(['companies.view']));
    const withReports = getVisibleNavItems(new Set(['reports.view']));

    const headersNoReports = noReports.filter(isHeader).map((h) => h.section);
    const headersWithReports = withReports.filter(isHeader).map((h) => h.section);

    expect(headersNoReports).not.toContain('Analytics');
    expect(headersWithReports).toContain('Analytics');
  });

  it('injects Automations header when workflows.view or jobs.view is held', () => {
    const withWorkflows = getVisibleNavItems(new Set(['workflows.view']));
    const withJobs = getVisibleNavItems(new Set(['jobs.view']));

    const headersWorkflows = withWorkflows.filter(isHeader).map((h) => h.section);
    const headersJobs = withJobs.filter(isHeader).map((h) => h.section);

    expect(headersWorkflows).toContain('Automations');
    expect(headersJobs).toContain('Automations');
  });

  it('returns plain JSON-serializable objects safe for Server-to-Client boundary transfer', () => {
    const allHeld = new Set(SECTIONS.map((s) => s.permission).filter(Boolean) as string[]);
    const items = getVisibleNavItems(allHeld);

    // Round-trip through JSON must preserve exact equality without functions or symbols
    const serialized = JSON.stringify(items);
    const deserialized = JSON.parse(serialized);

    expect(deserialized).toEqual(items);
  });

  it('matches all 23 defined sections when full permissions are held', () => {
    const allPermissions = new Set([
      'users.view',
      'users.manage',
      'roles.view',
      'roles.manage',
      'teams.view',
      'departments.view',
      'audit_logs.view',
      'companies.view',
      'contacts.view',
      'deals.view',
      'activities.view',
      'pipelines.view',
      'projects.view',
      'tasks.view',
      'workflows.view',
      'jobs.view',
      'reports.view',
      'notifications.view',
    ]);
    const items = getVisibleNavItems(allPermissions);
    const entries = items.filter(isEntry);
    expect(entries.length).toBe(SECTIONS.length);
  });

  it('never duplicates section headers even with multiple contiguous items in a section', () => {
    const allReports = getVisibleNavItems(new Set(['reports.view']));
    const headers = allReports.filter(isHeader).map((h) => h.section);

    expect(headers.filter((h) => h === 'Analytics').length).toBe(1);
  });

  it('injects section header immediately before the first visible item when earlier items in that section are hidden', () => {
    // jobs.view is held, but workflows.view (which precedes jobs in Automations) is not held
    const items = getVisibleNavItems(new Set(['jobs.view']));
    const jobsIdx = items.findIndex((i) => i.kind === 'entry' && i.label === 'Jobs');
    expect(jobsIdx).toBeGreaterThan(0);
    expect(items[jobsIdx - 1]).toEqual({ kind: 'header', section: 'Automations' });
  });

  it('ensures all defined sections have unique, valid root-relative destination paths', () => {
    const hrefs = SECTIONS.map((s) => s.href);
    const uniqueHrefs = new Set(hrefs);

    expect(uniqueHrefs.size).toBe(SECTIONS.length);
    for (const href of hrefs) {
      expect(href.startsWith('/')).toBe(true);
    }
  });
});
