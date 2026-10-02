import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * P1-1 regression: creating a company without `countryCode` must not 500.
 *
 * `companies.country_code` is `char(2) NOT NULL DEFAULT 'IN'` (migration 0033).
 * The zod `CreateCompanySchema` now applies `.default('IN')`, so the INSERT in
 * `createCompany` never sends an explicit NULL for the column (explicit NULL
 * used to override the DB default and violate the NOT NULL constraint).
 *
 * These tests call the real service functions (createCompany / updateCompany)
 * with a genuine Authorization minted by requirePermission() through a real
 * Better Auth session (the shared authz fixtures), so they exercise the full
 * path: zod boundary → withAuthorizedDb (RLS identity) → the INSERT.
 *
 * Service-layer imports are dynamic so this file collects (and skips) on a
 * plain `pnpm test` without credentials — the lib import chain validates env
 * at import time. In CI, run with DATABASE_URL_TEST (pooled) and
 * DATABASE_URL_MIGRATE (direct, app_owner).
 *
 * Covers:
 *  - createCompany({ name }) succeeds and returns countryCode 'IN' (the
 *    pre-fix code 500ed here)
 *  - the stored row really carries country_code = 'IN'
 *  - updateCompany without countryCode does not clobber a custom value
 *    (zod v4 applies .default() through .partial(), so the update schema
 *    deliberately carries no default)
 *  - explicit countryCode: null is rejected at the validation boundary
 *    (ZodError → 400 at the route), never reaching the NOT NULL column
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);
const owner = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE }) : null;

/** Unique per run: the companies table is permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);

describe.skipIf(!HAS_DB)('company countryCode default (P1-1)', () => {
  let createCompany: (
    auth: unknown,
    input: unknown,
  ) => Promise<{ id: string; countryCode: string | null }>;
  let updateCompany: (
    auth: unknown,
    id: string,
    input: unknown,
  ) => Promise<{ id: string; countryCode: string | null }>;
  let authFor: (permission: string) => Promise<unknown>;

  beforeAll(async () => {
    // Dynamic: the lib import chain validates env at import time, which would
    // break graceful skipping on machines without credentials.
    const companies = await import('@/lib/crm/companies');
    createCompany = companies.createCompany as typeof createCompany;
    updateCompany = companies.updateCompany as typeof updateCompany;
    const { requirePermission } = await import('@/lib/authz/require-permission');
    const { headersFor, mkAccount, mkCustomRole } = await import('../authz/fixtures');

    const org = (
      await owner!.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1,$2) returning id`,
        [`P1-1 ${RUN}`, `p11-${RUN}`],
      )
    ).rows[0]!.id;
    const dept = (
      await owner!.query<{ id: string }>(
        `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
        [org, `P11_${RUN}`, `P1-1 Dept ${RUN}`],
      )
    ).rows[0]!.id;
    const role = await mkCustomRole(owner!, org, `P11_C_${RUN}`, [
      ['companies.view', 'GLOBAL'],
      ['companies.create', 'GLOBAL'],
      ['companies.edit', 'GLOBAL'],
    ]);
    const account = await mkAccount(owner!, {
      org,
      dept,
      run: RUN,
      label: 'P1-1-Rep',
      customRoles: [role],
    });
    authFor = (permission: string) => requirePermission(headersFor(account.cookie), { permission });
  });

  afterAll(async () => {
    await owner!.end();
  });

  it('creates a company with just { name } and returns countryCode IN', async () => {
    const company = await createCompany(await authFor('companies.create'), {
      name: `P1-1 Co ${RUN}`,
    });
    expect(company.countryCode).toBe('IN');
    const { rows } = await owner!.query<{ country_code: string }>(
      `select country_code from public.companies where id = $1`,
      [company.id],
    );
    expect(rows[0]!.country_code).toBe('IN');
  });

  it('an update that omits countryCode leaves the stored value untouched', async () => {
    const company = await createCompany(await authFor('companies.create'), {
      name: `P1-1 Co US ${RUN}`,
      countryCode: 'us',
    });
    expect(company.countryCode).toBe('US');
    const updated = await updateCompany(await authFor('companies.edit'), company.id, {
      phone: '+91 80 0000 0000',
    });
    expect(updated.countryCode).toBe('US');
  });

  it('explicit countryCode: null is rejected at the validation boundary', async () => {
    await expect(
      createCompany(await authFor('companies.create'), {
        name: `P1-1 Co Null ${RUN}`,
        countryCode: null,
      }),
    ).rejects.toThrow();
    await expect(
      updateCompany(await authFor('companies.edit'), '00000000-0000-0000-0000-000000000000', {
        countryCode: null,
      }),
    ).rejects.toThrow();
  });
});
