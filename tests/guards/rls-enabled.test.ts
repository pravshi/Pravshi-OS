import { describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

describe('every table in public has RLS enabled AND forced', () => {
  it('finds no unprotected table', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
    const { rows } = await pool.query<{ relname: string; enabled: boolean; forced: boolean }>(`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname not like '\\_%'          -- probe tables from tests
        and c.relname <> '__drizzle_migrations'
        and (not c.relrowsecurity or not c.relforcerowsecurity)
    `);
    await pool.end();
    expect(rows, `Unprotected tables: ${rows.map((r) => r.relname).join(', ')}`).toEqual([]);
  });
});
