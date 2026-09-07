import { describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

describe('the runtime role cannot defeat RLS', () => {
  it('has no BYPASSRLS and owns no tables', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
    const role = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    const owned = await pool.query<{ n: number }>(`
      select count(*)::int as n
      from pg_class c join pg_roles r on r.oid = c.relowner
      where r.rolname = current_user and c.relkind = 'r'
    `);
    await pool.end();

    expect(role.rows[0]?.rolbypassrls, 'runtime role must not have BYPASSRLS').toBe(false);
    expect(role.rows[0]?.rolsuper, 'runtime role must not be superuser').toBe(false);
    expect(owned.rows[0]?.n, 'runtime role must own no tables').toBe(0);
  });
});
