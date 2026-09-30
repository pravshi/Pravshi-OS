import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * G7 — TOTP enrollment audit, behavioral.
 *
 * Enrollment itself runs through Better Auth's client plugin, but the audit trail must not
 * depend on the client: migration 0027 installs a SECURITY DEFINER trigger
 * (authz.audit_two_factor_change) on auth.auth_two_factors that writes HIGH audit entries
 * for the whole lifecycle — enroll / enabled / backup-codes-regenerated / disabled.
 *
 * These tests exercise the trigger for real: every lifecycle transition must produce exactly
 * one audit row with the right action, and the secret / backup codes must never reach
 * audit_logs. Failed-verification bumps are deliberately quiet.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const RUN = Math.random().toString(36).slice(2, 8);
const SECRET = `G7SECRET-${RUN}-aaaaaaaa`;
const CODES_V1 = `G7CODES-${RUN}-111111`;
const CODES_V2 = `G7CODES-${RUN}-222222`;

let orgId = '';
let personId = '';
let authUserId = '';
let orphanAuthUserId = '';

const auditCount = async () =>
  (
    await owner.query<{ n: string }>(
      `select count(*) n from public.audit_logs where org_id = $1 and entity_type = 'auth_two_factor'`,
      [orgId],
    )
  ).rows[0]!.n;

const latestAudit = async () =>
  (
    await owner.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      severity: string;
      result: string;
      actor_person_id: string | null;
      actor_email_snapshot: string | null;
      metadata: unknown;
    }>(
      `select action, entity_type, entity_id::text, severity, result,
              actor_person_id::text, actor_email_snapshot, metadata
         from public.audit_logs
        where org_id = $1 and entity_type = 'auth_two_factor'
        order by occurred_at desc limit 1`,
      [orgId],
    )
  ).rows[0];

const auditRowLeaksSecret = async () => {
  const rows = await owner.query(
    `select * from public.audit_logs where org_id = $1 and entity_type = 'auth_two_factor'`,
    [orgId],
  );
  const dumped = JSON.stringify(rows.rows);
  return dumped.includes(SECRET) || dumped.includes(CODES_V1) || dumped.includes(CODES_V2);
};

beforeAll(async () => {
  orgId = (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1, $2) returning id`,
      [`G7 Org ${RUN}`, `g7-${RUN}`],
    )
  ).rows[0]!.id;

  authUserId = (
    await owner.query<{ id: string }>(
      `insert into auth.auth_users (name, email) values ($1, $2) returning id`,
      [`G7 User`, `g7.${RUN}@example.test`],
    )
  ).rows[0]!.id;

  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid, 'EMP', '2026') c`, [
      orgId,
    ])
  ).rows[0]!.c;
  personId = (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, person_status, auth_user_id, work_email)
       values ($1, $2, $3, 'ACTIVE', $4, $5) returning id`,
      [orgId, code, 'G7 Person', authUserId, `g7.${RUN}@example.test`],
    )
  ).rows[0]!.id;

  // An auth user with no linked person: the trigger must stay silent, not fabricate.
  orphanAuthUserId = (
    await owner.query<{ id: string }>(
      `insert into auth.auth_users (name, email) values ($1, $2) returning id`,
      [`G7 Orphan`, `g7-orphan.${RUN}@example.test`],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
});

describe('TOTP lifecycle audit trigger', () => {
  let factorId = '';

  it('INSERT writes mfa.totp.enroll (HIGH, SUCCESS, attributed to the person)', async () => {
    const before = await auditCount();
    factorId = (
      await owner.query<{ id: string }>(
        `insert into auth.auth_two_factors (user_id, secret, backup_codes, verified)
         values ($1, $2, $3, false) returning id`,
        [authUserId, SECRET, CODES_V1],
      )
    ).rows[0]!.id;

    expect(await auditCount()).toBe(String(Number(before) + 1));
    const row = (await latestAudit())!;
    expect(row.action).toBe('mfa.totp.enroll');
    expect(row.entity_type).toBe('auth_two_factor');
    expect(row.entity_id).toBe(factorId);
    expect(row.severity).toBe('HIGH');
    expect(row.result).toBe('SUCCESS');
    expect(row.actor_person_id).toBe(personId);
    expect(row.actor_email_snapshot).toBe(`g7.${RUN}@example.test`);
  });

  it('UPDATE verified false→true writes mfa.totp.enabled', async () => {
    const before = await auditCount();
    await owner.query(`update auth.auth_two_factors set verified = true where id = $1`, [factorId]);
    expect(await auditCount()).toBe(String(Number(before) + 1));
    expect((await latestAudit())!.action).toBe('mfa.totp.enabled');
  });

  it('UPDATE backup_codes writes mfa.backup_codes.regenerated', async () => {
    const before = await auditCount();
    await owner.query(`update auth.auth_two_factors set backup_codes = $2 where id = $1`, [
      factorId,
      CODES_V2,
    ]);
    expect(await auditCount()).toBe(String(Number(before) + 1));
    expect((await latestAudit())!.action).toBe('mfa.backup_codes.regenerated');
  });

  it('failed-verification bumps stay quiet (no lifecycle event)', async () => {
    const before = await auditCount();
    await owner.query(
      `update auth.auth_two_factors set failed_verification_count = failed_verification_count + 1 where id = $1`,
      [factorId],
    );
    expect(await auditCount()).toBe(before);
  });

  it('DELETE writes mfa.totp.disabled', async () => {
    const before = await auditCount();
    await owner.query(`delete from auth.auth_two_factors where id = $1`, [factorId]);
    expect(await auditCount()).toBe(String(Number(before) + 1));
    const row = (await latestAudit())!;
    expect(row.action).toBe('mfa.totp.disabled');
    expect(row.entity_id).toBe(factorId);
  });

  it('never leaks the secret or backup codes into audit_logs', async () => {
    expect(await auditRowLeaksSecret()).toBe(false);
  });

  it('stays silent for an auth user with no linked person (no fabricated identity)', async () => {
    const before = await auditCount();
    await owner.query(
      `insert into auth.auth_two_factors (user_id, secret, backup_codes, verified)
       values ($1, $2, $3, false)`,
      [orphanAuthUserId, `ORPHAN-${RUN}`, `ORPHAN-CODES-${RUN}`],
    );
    expect(await auditCount()).toBe(before);
  });
});
