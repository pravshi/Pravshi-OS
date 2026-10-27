/**
 * Migration 0085 (LOCK-1), at the database: every writer stores the login address lower-cased,
 * the CHECK holds, a second login cannot differ from an existing one only in case (so 0085's
 * collision guard can never meet a real collision: the address is citext UNIQUE), and the
 * normalising function is reachable by no one. The end-to-end behaviour — lockout, reset and
 * login-event attribution in any spelling — is tests/integration/login-email-case.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY } from '../workflows/helpers';

async function stateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return String(error);
  }
}

describe.skipIf(!DB_READY)('login address case (0085, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  owner.on('error', () => undefined);
  const RUN = randomBytes(4).toString('hex');

  afterAll(async () => {
    await owner.end();
  });

  /** Runs fn in an owner transaction that is always rolled back. */
  const rehearse = async <T>(fn: (q: Pool['query']) => Promise<T>) => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      return await fn(c.query.bind(c) as Pool['query']);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  it('every insert and update stores the address lower-cased', async () => {
    await rehearse(async (q) => {
      const id = (
        await q<{ id: string; email: string }>(
          `insert into auth.auth_users (name, email, email_verified) values ('X', $1, false)
           returning id, email::text`,
          [`Insert.${RUN}@Example.COM`],
        )
      ).rows[0]!;
      expect(id.email).toBe(`insert.${RUN}@example.com`);
      const updated = await q<{ email: string }>(
        `update auth.auth_users set email = $2 where id = $1 returning email::text`,
        [id.id, `Changed.${RUN}@Example.ORG`],
      );
      expect(updated.rows[0]!.email).toBe(`changed.${RUN}@example.org`);
    });
  });

  it('a second login differing only in case is refused, never merged', async () => {
    await rehearse(async (q) => {
      await q(`insert into auth.auth_users (name, email, email_verified) values ('A', $1, false)`, [
        `dup.${RUN}@example.com`,
      ]);
      expect(
        await stateOf(
          q(`insert into auth.auth_users (name, email, email_verified) values ('B', $1, false)`, [
            `DUP.${RUN}@EXAMPLE.COM`,
          ]),
        ),
      ).toBe('23505');
    });
  });

  it('the CHECK, the trigger and the function are in place; no stored address has upper case', async () => {
    const res = await owner.query<{
      con: boolean;
      trg: boolean;
      upper: number;
      public_exec: boolean;
    }>(
      `select exists (select 1 from pg_constraint where conname = 'auth_users_email_lowercase') con,
              exists (select 1 from pg_trigger where tgname = 'auth_users_normalize_email'
                        and tgrelid = 'auth.auth_users'::regclass and tgenabled = 'O') trg,
              (select count(*)::int from auth.auth_users where email::text <> lower(email::text)) upper,
              has_function_privilege('app_user', 'auth.normalize_login_email()', 'EXECUTE')
                or has_function_privilege('app_auth', 'auth.normalize_login_email()', 'EXECUTE') public_exec`,
    );
    expect(res.rows[0]).toEqual({ con: true, trg: true, upper: 0, public_exec: false });
  });

  it('the organization lookup before sign-in ignores case', async () => {
    await rehearse(async (q) => {
      const org = (
        await q<{ id: string }>(
          `insert into public.organizations (name, slug) values ('C', $1) returning id`,
          [`case-${RUN}`],
        )
      ).rows[0]!.id;
      await q(
        `insert into public.people (org_id, code, full_legal_name, work_email, person_status)
         values ($1, 'EMP-2026-000001', 'C', $2, 'ACTIVE')`,
        [org, `Person.${RUN}@Example.com`],
      );
      const found = await q<{ o: string }>(`select public.resolve_login_org($1::citext) o`, [
        `PERSON.${RUN}@EXAMPLE.COM`,
      ]);
      expect(found.rows[0]!.o).toBe(org);
    });
  });
});
