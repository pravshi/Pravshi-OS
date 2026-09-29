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
    const last = journal.entries[journal.entries.length - 1];
    expect(last).toBeDefined();
    expect(last!.tag).toBe('0028_admin_write_functions');
    const idxs = journal.entries.map((e) => e.idx);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  });
});

describe('navigation exposes the new admin surfaces', () => {
  it('sidebar and nav know the permissions and teams entries', () => {
    const sidebar = read('components/shell/sidebar.tsx');
    expect(sidebar).toContain("href: '/admin/permissions'");
    expect(sidebar).toContain("href: '/admin/teams'");
    const nav = read('lib/authz/nav.ts');
    for (const p of ['users.manage', 'roles.manage', 'teams.view']) {
      expect(nav).toContain(`'${p}'`);
    }
  });
});
