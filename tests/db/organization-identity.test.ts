/**
 * Phase 3, MT-L1 (migration 0077) — an organization's id and slug are fixed once it
 * is created; the columns an organization's lifecycle needs stay writable.
 *
 * Probed as the owner (app_owner, DATABASE_URL_MIGRATE): it is the only role with an
 * UPDATE path on organizations at all, so it is where the trigger is the barrier.
 * The runtime role is probed too, to pin that it has no path to begin with.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { mkOrg } from '../workflows/helpers';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);

async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'SUCCEEDED';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

// Referenced by its seeded roles, so before 0077 an id change already failed — on
// the foreign keys, with 23503. The freeze fires BEFORE UPDATE, ahead of any
// foreign-key check, so 23514 is what proves the freeze answered.
let orgUsed = '';

const read = async (id: string) =>
  (
    await owner.query<{ id: string; slug: string; name: string; status: string }>(
      `select id, slug, name, status from public.organizations where id = $1`,
      [id],
    )
  ).rows[0];

describe.skipIf(!HAS_DB)('organization identity is fixed (MT-L1, 0077)', () => {
  beforeAll(async () => {
    orgUsed = await mkOrg(owner, `orgid-used-${RUN}`);
  });

  afterAll(async () => {
    await owner.end();
    await asUser.end();
  });

  it('refuses an id change with the freeze, not a foreign-key accident', async () => {
    expect(
      await sqlstateOf(
        owner.query(`update public.organizations set id = $1 where id = $2`, [
          randomUUID(),
          orgUsed,
        ]),
      ),
    ).toBe('23514');
    expect((await read(orgUsed))?.id).toBe(orgUsed);
  });

  it('refuses a slug change, including a case-only one', async () => {
    const before = await read(orgUsed);
    for (const slug of [`renamed-${RUN}`, before!.slug.toUpperCase()]) {
      expect(
        await sqlstateOf(
          owner.query(`update public.organizations set slug = $1 where id = $2`, [slug, orgUsed]),
        ),
        slug,
      ).toBe('23514');
    }
    expect((await read(orgUsed))?.slug).toBe(before!.slug);
  });

  it('refuses a change hidden among allowed columns', async () => {
    expect(
      await sqlstateOf(
        owner.query(`update public.organizations set name = 'X', slug = $1 where id = $2`, [
          `sneaky-${RUN}`,
          orgUsed,
        ]),
      ),
    ).toBe('23514');
  });

  it('keeps the lifecycle columns writable: name, status, deleted_at', async () => {
    await owner.query(`update public.organizations set name = $1 where id = $2`, [
      `Renamed ${RUN}`,
      orgUsed,
    ]);
    await owner.query(`update public.organizations set status = 'SUSPENDED' where id = $1`, [
      orgUsed,
    ]);
    await owner.query(
      `update public.organizations set status = 'ACTIVE', deleted_at = now() where id = $1`,
      [orgUsed],
    );
    await owner.query(`update public.organizations set deleted_at = null where id = $1`, [orgUsed]);
    expect(await read(orgUsed)).toMatchObject({ name: `Renamed ${RUN}`, status: 'ACTIVE' });
  });

  it('an update that leaves id and slug unchanged is allowed', async () => {
    const r = await read(orgUsed);
    expect(
      await sqlstateOf(
        owner.query(`update public.organizations set id = id, slug = slug where id = $1`, [r!.id]),
      ),
    ).toBe('SUCCEEDED');
  });

  it('the runtime role has no update path to organizations at all', async () => {
    expect(
      await sqlstateOf(
        asUser.query(`update public.organizations set slug = 'x' where id = $1`, [orgUsed]),
      ),
    ).toBe('42501');
  });

  it('the trigger is installed and enabled', async () => {
    const t = await owner.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger
        where tgrelid = 'public.organizations'::regclass
          and tgname = 'organizations_identity_freeze'`,
    );
    expect(t.rows).toEqual([{ tgenabled: 'O' }]);
  });
});
