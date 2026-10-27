import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0080_organization_types.down.sql promises to restore the 0079 state.
 * This pins that promise statically, as the 0075 and 0077 rollback guards do: the rollback
 * undoes exactly what 0080 adds, refuses while an organization is on anything but
 * generic_crm v1, and the seed_default_pipeline it restores is 0039's word for word — a
 * rollback that restored a different function would be a new migration nobody reviewed.
 * (Executed against a disposable database too: a rolled-back 0080 database matched a fresh
 * 0079 database on every order-stable schema fingerprint.)
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0039 = read('drizzle', '0039_pipeline_assignment_recovery.sql');
const M0080 = read('drizzle', '0080_organization_types.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0080_organization_types.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');

/** The `create or replace function public.seed_default_pipeline … $$;` statement of a file. */
function seedDefaultPipeline(sql: string): string {
  const m = sql.match(/create or replace function public\.seed_default_pipeline[\s\S]*?\$\$;/);
  expect(m, 'create or replace function public.seed_default_pipeline').not.toBeNull();
  return squash(stripComments(m![0]));
}

describe('0080 does what its rollback undoes', () => {
  it('0080 adds the catalog, the templates, the columns, the guard and the template seeders', () => {
    expect(M0080).toMatch(/create table public\.organization_types \(/);
    expect(M0080).toMatch(/create table public\.organization_type_templates \(/);
    expect(M0080).toMatch(/add column type_key text not null default 'generic_crm'/);
    expect(M0080).toMatch(/add column template_version integer not null default 1/);
    expect(M0080).toMatch(/create trigger organizations_type_guard/);
    expect(M0080).toMatch(/create function public\.seed_template_pipelines\(/);
    expect(M0080).toMatch(/create function public\.upgrade_organization_template\(/);
  });

  it('the rollback runs in one transaction and refuses before changing anything', () => {
    expect(ROLLBACK).toMatch(/^begin;$/m);
    expect(ROLLBACK).toMatch(/^commit;$/m);
    const statements = splitStatements(ROLLBACK).map((s) => squash(stripComments(s)));
    const refusal = statements.findIndex((s) => s.includes('0080 rollback refused'));
    const firstChange = statements.findIndex((s) => /^(drop|alter|create)/.test(s));
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(firstChange);
  });

  it("the rollback restores 0039's seed_default_pipeline exactly", () => {
    expect(seedDefaultPipeline(ROLLBACK)).toBe(seedDefaultPipeline(M0039));
  });

  it('the rollback touches nothing 0080 did not', () => {
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0)
      .map((s) => s.split(' ').slice(0, 4).join(' '));
    expect(heads).toEqual([
      'begin;',
      'set local lock_timeout =',
      'do $$ begin if',
      'drop trigger if exists',
      'drop function if exists',
      'drop function if exists',
      'create or replace function',
      'comment on function public.seed_default_pipeline(uuid)',
      'revoke all on function',
      'drop function if exists',
      'alter table public.organizations drop',
      'drop index if exists',
      'alter table public.organizations drop',
      'drop table if exists',
      'drop function if exists',
      'drop table if exists',
      'drop function if exists',
      'commit;',
    ]);
  });
});
