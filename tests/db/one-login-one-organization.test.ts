/**
 * ADR-007 GOV-02 — one login belongs to exactly one organization in V1.
 *
 * The rule is enforced by the schema, and ADR-007 lists "a test pins that a login cannot hold a
 * person in a second organization" in GOV-02's definition of done. This is that test. It decides
 * nothing: it asserts the constraints that already exist (`people_auth_user_unique`,
 * `auth_users_email_unique`) so that a later migration cannot quietly remove them — multi-
 * organization membership is NOT V1 work, and platform provisioning relies on this rule (it
 * refuses an administrator email that already has a login).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkLogin, mkOrg, mkPerson, ownerPool, runId } from '../authz/fixtures';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);
const owner = HAS_DB ? ownerPool() : null;

/** SQLSTATE and constraint of a rejection, or NO ERROR. */
async function rejection(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return `${e.code ?? 'no-code'}:${e.constraint ?? 'no-constraint'}`;
  }
}

describe.skipIf(!HAS_DB)('one login, one organization (ADR-007 GOV-02)', () => {
  const run = runId();

  afterAll(async () => {
    await owner?.end();
  });

  it('refuses to give one login a person in a second organization', async () => {
    const orgA = await mkOrg(owner!, `gov02-a-${run}`);
    const orgB = await mkOrg(owner!, `gov02-b-${run}`);
    const login = await mkLogin('gov02-one', run);
    await mkPerson(owner!, orgA, 'First', { authUserId: login.id });

    expect(await rejection(mkPerson(owner!, orgB, 'Second', { authUserId: login.id }))).toBe(
      '23505:people_auth_user_unique',
    );
  });

  it('refuses a second person for the same login in the same organization too', async () => {
    const org = await mkOrg(owner!, `gov02-c-${run}`);
    const login = await mkLogin('gov02-two', run);
    await mkPerson(owner!, org, 'First', { authUserId: login.id });

    expect(await rejection(mkPerson(owner!, org, 'Second', { authUserId: login.id }))).toBe(
      '23505:people_auth_user_unique',
    );
  });

  it('keeps the login bound after the person is soft-deleted (it cannot move organizations)', async () => {
    const orgA = await mkOrg(owner!, `gov02-d-${run}`);
    const orgB = await mkOrg(owner!, `gov02-e-${run}`);
    const login = await mkLogin('gov02-three', run);
    const person = await mkPerson(owner!, orgA, 'Leaver', { authUserId: login.id });
    await owner!.query(`update public.people set deleted_at = now() where id = $1`, [person]);

    expect(await rejection(mkPerson(owner!, orgB, 'Joiner', { authUserId: login.id }))).toBe(
      '23505:people_auth_user_unique',
    );
  });

  it('refuses a second login with the same email address, whatever its case', async () => {
    const login = await mkLogin('gov02-mail', run);
    const duplicate = await rejection(
      owner!.query(
        `insert into auth.auth_users (id, name, email, email_verified)
         values (gen_random_uuid(), 'Duplicate', upper($1), false)`,
        [login.email],
      ),
    );
    // email is citext: the comparison ignores case, so the upper-cased address collides.
    expect(duplicate).toBe('23505:auth_users_email_unique');
  });

  it('shows the two constraints are still the schema’s definition of the rule', async () => {
    const { rows } = await owner!.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
       where indexname in ('people_auth_user_unique', 'auth_users_email_unique')
       order by indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'auth_users_email_unique',
      'people_auth_user_unique',
    ]);
    // Not partial on deleted_at: a soft-deleted person still holds the login.
    expect(rows.find((r) => r.indexname === 'people_auth_user_unique')!.indexdef).not.toMatch(
      /deleted_at/,
    );
  });
});
