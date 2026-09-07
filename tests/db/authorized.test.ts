import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { pool } from '@/lib/db/pool';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const ORG = '33333333-3333-3333-3333-333333333333';

// Owner-level setup runs on the migrate connection, not the app connection.
beforeAll(async () => {
  const { Pool } = await import('@neondatabase/serverless');
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.query(`
    create table if not exists public._ctx_probe (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null,
      owner_person_id uuid not null
    );

    -- Seed BEFORE arming RLS. FORCE ROW LEVEL SECURITY deliberately subjects the
    -- table owner to its own policies, and the only policy here is FOR SELECT, so
    -- seeding after the ALTER fails with "new row violates row-level security
    -- policy". Disabling first also makes a re-run idempotent when the table
    -- survives from an earlier run. The table is ENABLE + FORCE for every
    -- assertion below, which is the property under test.
    alter table public._ctx_probe disable row level security;
    truncate public._ctx_probe;
    insert into public._ctx_probe (org_id, owner_person_id)
      values ('${ORG}', '${ALICE}'), ('${ORG}', '${BOB}');

    alter table public._ctx_probe enable row level security;
    alter table public._ctx_probe force  row level security;
    drop policy if exists ctx_probe_select on public._ctx_probe;
    create policy ctx_probe_select on public._ctx_probe for select to app_user
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         and owner_person_id = nullif(current_setting('app.person_id', true), '')::uuid);
    grant select on public._ctx_probe to app_user;
  `);
  await owner.end();
});

afterAll(async () => {
  const { Pool } = await import('@neondatabase/serverless');
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.query('drop table if exists public._ctx_probe;');
  await owner.end();
  await pool.end();
});

describe('withAuthorizedDb', () => {
  it('returns only the rows belonging to the context person', async () => {
    const rows = await withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' }, (tx) =>
      tx.execute(sql`select owner_person_id from public._ctx_probe`),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.owner_person_id).toBe(ALICE);
  });

  it('does not leak context to a query outside the helper — fail closed', async () => {
    const direct = await pool.query('select count(*)::int as n from public._ctx_probe');
    expect(direct.rows[0]?.n).toBe(0);
  });

  it('isolates two contexts used back to back on the same pool', async () => {
    const a = await withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' }, (tx) =>
      tx.execute(sql`select owner_person_id from public._ctx_probe`),
    );
    const b = await withAuthorizedDb({ personId: BOB, orgId: ORG, aal: 'aal1' }, (tx) =>
      tx.execute(sql`select owner_person_id from public._ctx_probe`),
    );
    expect(a.rows[0]?.owner_person_id).toBe(ALICE);
    expect(b.rows[0]?.owner_person_id).toBe(BOB);
  });

  it('releases the connection back to the pool on every call', async () => {
    // pool max is 5. If release() is missing, the sixth call hangs and this times out.
    for (let i = 0; i < 12; i++) {
      await withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' }, (tx) =>
        tx.execute(sql`select 1`),
      );
    }
    expect(true).toBe(true);
  });

  it('rolls back the context when the callback throws', async () => {
    await expect(
      withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await pool.query(`select current_setting('app.person_id', true) as p`);
    expect(after.rows[0]?.p ?? '').toBe('');
  });
});
