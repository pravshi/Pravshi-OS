import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 1 RBAC admin surfaces — static guards over the role/permission/team
 * administration code. These are source-text checks in the style of the other
 * guards: they pin the authorization contract (which permission gates which
 * surface) and the narrow-function write pattern (app_user holds no direct
 * writes on role_permissions, departments, teams, or team_members, so every
 * mutation must go through a SECURITY DEFINER function granted only to
 * app_user).
 */

const root = (p: string) => `src/${p}`;
const read = (p: string) => readFileSync(root(p), 'utf8');

describe('admin page authorization', () => {
  it('/admin/roles is gated on roles.manage', () => {
    const page = read('app/(app)/admin/roles/page.tsx');
    expect(page).toContain("requirePagePermission('roles.manage')");
  });

  it('/admin/roles grid data and saves are gated on roles.manage', () => {
    const actions = read('app/(app)/admin/roles/actions.ts');
    expect(actions).toContain("{ permission: 'roles.manage' }");
    expect(actions).toContain("permission: 'roles.manage'");
    expect(actions).toContain("minScope: 'GLOBAL'");
    expect(actions).not.toContain("permission: 'roles.view'");
  });

  it('/admin/permissions answers roles.manage OR users.manage', () => {
    const actions = read('app/(app)/admin/permissions/actions.ts');
    expect(actions).toContain("permission: 'roles.manage'");
    expect(actions).toContain("permission: 'users.manage'");
    expect(actions).toContain('/access-denied');
  });

  it('/admin/teams reads on teams.view and mutates on teams.manage', () => {
    const actions = read('app/(app)/admin/teams/actions.ts');
    expect(actions).toContain("{ permission: 'teams.view' }");
    expect(actions.match(/\{\s*permission:\s*'teams\.manage'\s*\}/g)?.length).toBe(4);
    const page = read('app/(app)/admin/teams/page.tsx');
    expect(page).toContain("requirePagePermission('teams.view')");
  });
});

describe('narrow SECURITY DEFINER write pattern', () => {
  it('role grant writes go through set_role_permissions()', () => {
    const svc = read('lib/admin/roles.ts');
    expect(svc).toContain('public.set_role_permissions(');
    for (const stmt of [
      'insert into public.role_permissions',
      'update public.role_permissions',
      'delete from public.role_permissions',
    ]) {
      expect(svc.toLowerCase()).not.toContain(stmt);
    }
  });

  it('department writes go through create_department()/archive_department()', () => {
    const svc = read('lib/admin/departments.ts');
    expect(svc).toContain('public.create_department(');
    expect(svc).toContain('public.archive_department(');
    for (const stmt of [
      'insert into public.departments',
      'update public.departments',
      'delete from public.departments',
    ]) {
      expect(svc.toLowerCase()).not.toContain(stmt);
    }
  });

  it('team and membership writes go through the narrow team functions', () => {
    const svc = read('lib/admin/teams.ts');
    for (const fn of [
      'public.create_team(',
      'public.update_team(',
      'public.archive_team(',
      'public.set_team_members(',
    ]) {
      expect(svc).toContain(fn);
    }
    for (const stmt of [
      'insert into public.teams',
      'update public.teams',
      'delete from public.teams',
      'insert into public.team_members',
      'update public.team_members',
      'delete from public.team_members',
    ]) {
      expect(svc.toLowerCase()).not.toContain(stmt);
    }
  });

  it('migration 0028 defines SECURITY DEFINER functions granted only to app_user', () => {
    const mig = readFileSync('drizzle/0028_admin_write_functions.sql', 'utf8');
    const functions = [
      'set_role_permissions(uuid, jsonb)',
      'create_department(text, text, uuid)',
      'archive_department(uuid)',
      'create_team(uuid, text, uuid)',
      'update_team(uuid, text, uuid)',
      'archive_team(uuid)',
      'set_team_members(uuid, uuid[])',
    ];
    expect(mig.match(/^create function /gim)?.length).toBe(functions.length);
    expect(mig.match(/^security definer$/gim)?.length).toBe(functions.length);
    for (const fn of functions) {
      expect(mig).toContain(`revoke all on function public.${fn} from public;`);
      expect(mig).toContain(`grant execute on function public.${fn} to app_user;`);
    }
  });

  it('migration 0028 is registered in the drizzle journal', () => {
    expect(existsSync('drizzle/0028_admin_write_functions.sql')).toBe(true);
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === '0028_admin_write_functions');
    expect(entry).toBeDefined();
    const idxs = journal.entries.map((e) => e.idx);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  });
});

/**
 * The source text that defines the sidebar's entries. They lived inline in sidebar.tsx and
 * moved to the shared shell module nav-items.ts (UI-02), which the mobile drawer also reads.
 * The guard follows the sidebar's own import rather than naming one file, so it pins whichever
 * definition the sidebar actually renders — and cannot be satisfied by a file it no longer uses.
 */
// Every spelling the sidebar can use to import the module: relative or the @/ alias, either
// quote, with or without the extension.
const NAV_ITEMS_IMPORT = /from\s+['"](?:\.\/|@\/components\/shell\/)nav-items(?:\.ts)?['"]/;

function sidebarNavSource(readFile: (p: string) => string): string {
  const sidebar = readFile('components/shell/sidebar.tsx');
  return NAV_ITEMS_IMPORT.test(sidebar) ? readFile('components/shell/nav-items.ts') : sidebar;
}

describe('navigation exposes the new admin surfaces', () => {
  it('sidebar and nav know the permissions and teams entries', () => {
    const navSource = sidebarNavSource(read);
    expect(navSource).toContain("href: '/admin/permissions'");
    expect(navSource).toContain("href: '/admin/teams'");
    const nav = read('lib/authz/nav.ts');
    for (const p of ['users.manage', 'roles.manage', 'teams.view']) {
      expect(nav).toContain(`'${p}'`);
    }
  });

  it('each entry keeps the permission its page is gated on', () => {
    const navSource = sidebarNavSource(read);
    expect(navSource).toMatch(/href: '\/admin\/permissions',\s*permission: 'roles\.manage'/);
    // The Permissions page also answers users.manage (see /admin/permissions above).
    expect(navSource).toContain("held.has('users.manage')");
    expect(navSource).toMatch(/href: '\/admin\/teams',\s*permission: 'teams\.view'/);
  });

  it('shows the Permissions entry to roles.manage OR users.manage, as its page answers', () => {
    const navSource = sidebarNavSource(read);
    // The OR is the Permissions entry's own visibility condition, not text elsewhere in the file.
    expect(navSource).toMatch(
      /const canSeePermissions\s*=\s*held\.has\('roles\.manage'\)\s*\|\|\s*held\.has\('users\.manage'\)/,
    );
    expect(navSource).toMatch(/s\.href === '\/admin\/permissions' && canSeePermissions/);
  });

  it('follows the definition the sidebar imports, not a file it no longer reads', () => {
    const files: Record<string, string> = {
      'components/shell/sidebar.tsx': "import { getVisibleNavItems } from './nav-items';",
      'components/shell/nav-items.ts': "{ href: '/admin/teams', permission: 'teams.view' }",
    };
    expect(sidebarNavSource((p) => files[p] ?? '')).toBe(files['components/shell/nav-items.ts']);

    const inline = { 'components/shell/sidebar.tsx': "{ href: '/admin/teams' }" };
    expect(sidebarNavSource((p) => inline[p as keyof typeof inline] ?? '')).toBe(
      inline['components/shell/sidebar.tsx'],
    );

    // A sidebar that delegates to nav-items.ts without the entries there must fail the guard,
    // even if stale entries remain in sidebar.tsx.
    const stale: Record<string, string> = {
      'components/shell/sidebar.tsx':
        "import { getVisibleNavItems } from './nav-items';\n// href: '/admin/teams'",
      'components/shell/nav-items.ts': "{ href: '/work', permission: 'projects.view' }",
    };
    expect(sidebarNavSource((p) => stale[p] ?? '')).not.toContain("href: '/admin/teams'");
  });

  it('recognises every supported spelling of the nav-items import', () => {
    const NAV_ITEMS = "{ href: '/admin/teams', permission: 'teams.view' }";
    for (const spec of [
      "'./nav-items'",
      '"./nav-items"',
      "'./nav-items.ts'",
      "'@/components/shell/nav-items'",
      '"@/components/shell/nav-items.ts"',
    ]) {
      const files: Record<string, string> = {
        'components/shell/sidebar.tsx': `import { getVisibleNavItems } from ${spec};`,
        'components/shell/nav-items.ts': NAV_ITEMS,
      };
      expect(
        sidebarNavSource((p) => files[p] ?? ''),
        spec,
      ).toBe(NAV_ITEMS);
    }
    // A different module that merely ends in "nav-items" is not the shared definition.
    const other: Record<string, string> = {
      'components/shell/sidebar.tsx': "import { x } from './old-nav-items';",
      'components/shell/nav-items.ts': NAV_ITEMS,
    };
    expect(sidebarNavSource((p) => other[p] ?? '')).toBe(other['components/shell/sidebar.tsx']);
  });
});
