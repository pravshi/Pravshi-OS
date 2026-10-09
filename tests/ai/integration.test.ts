/**
 * Phase 9 — AI API + integration tests (Workstream G, contract §11.1).
 *
 * Exercises the orchestrated request end-to-end against a live test
 * database with the deterministic MOCK provider (the default when
 * AI_PROVIDER is unset): an authenticated runAiRequest() under GENUINE
 * session identities — personas are real Better Auth logins created with
 * the shared Task 1.15 fixtures (tests/authz/fixtures.ts, the harness
 * tests/integration/crm-deal-pipeline.test.ts models), and every
 * Authorization is minted by requirePermission() itself, because the CRM
 * services enforce the issued-by-requirePermission brand and a fabricated
 * object literal is refused. Nothing about the AI path is mocked: context
 * is built by the real services, usage rows land in the real table, and
 * the §4.3 audit entry is written by the real audit writer.
 *
 * Covered: summary content grounded in seeded records · the §5.3 payload
 * shape · exactly one usage row per request with correct fields · the
 * ai.request audit entry · cross-tenant target → NOT_FOUND · the usage
 * read services (§8.3) · the LIMITED path (org kill switch).
 *
 * NOT covered here, deliberately: the NOT_CONFIGURED outcome. Provider
 * selection is resolved from the env snapshot parsed at import time
 * (src/env.ts), so it cannot be toggled inside a running suite; the
 * not-configured stub provider is covered at the provider layer
 * (tests/ai/provider.test.ts, Workstream B). No real-provider behaviour
 * is claimed anywhere in this file (prompt §14).
 *
 * On a plain `pnpm test` without credentials the suite collects and skips:
 * the service import chain validates env at import time, so service
 * modules are imported dynamically behind the HAS_DB gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import type { Authorization } from '@/lib/authz/require-permission';
import type { Account } from '../authz/fixtures';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/** Owner connection: seeds fixtures, bypasses RLS. */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: every seeded row is namespaced so other suites' data can't match. */
const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const TOK_A = `A9QA${RUN}`;

const tryImport = async <T>(path: string): Promise<T | null> => {
  try {
    return (await import(path)) as T;
  } catch {
    return null;
  }
};

type OrchestratorModule = typeof import('@/lib/ai/orchestrator');
type UsageModule = typeof import('@/lib/ai/usage');
type FixturesModule = typeof import('../authz/fixtures');
type AuthzModule = typeof import('@/lib/authz/require-permission');

/** Workstream C's §5.5 outcome union — the same type the route maps to HTTP. */
type AssistOutcome = Awaited<ReturnType<OrchestratorModule['runAiRequest']>>;

/* ── fixtures ─────────────────────────────────────────────────────────────
 * Personas come from the shared Task 1.15 fixtures (tests/authz/fixtures.ts):
 * mkCustomRole creates the role, mkAccount creates the real Better Auth
 * login + linked person + ACTIVE engagement, assigns the role and signs the
 * persona in. Authorizations are minted per call by authFor() below, via
 * requirePermission() over the persona's session cookie — the only source
 * of the brand the services enforce. The owner connection still seeds the
 * CRM records themselves (company, pipeline, deal) in beforeAll. */

const AI_PERMS = [
  'ai.use',
  'ai.usage.view',
  'ai.usage.manage',
  'companies.view',
  'deals.view',
] as const;

/** The fixtures' (permission, scope) grant shape: every grant GLOBAL. */
const aiGrants = (): [string, string][] => AI_PERMS.map((permission) => [permission, 'GLOBAL']);

describe.skipIf(!HAS_DB)('ai integration (§11.1)', () => {
  let orchestrator: OrchestratorModule | null = null;
  let usage: UsageModule | null = null;
  let fixtures: FixturesModule | null = null;
  let authz: AuthzModule | null = null;

  let orgA = '';
  let orgB = '';
  let alice = '';
  let aliceAcct!: Account;
  let bobAcct!: Account;
  let companyA = '';
  let dealA = '';

  /** A genuine Authorization, minted by requirePermission() through the persona's session. */
  const authFor = (account: Account, permission: string): Promise<Authorization> =>
    authz!.requirePermission(fixtures!.headersFor(account.cookie), { permission });

  const run = async (
    auth: Authorization,
    input: {
      capability: string;
      target?: { entityType: string; entityId: string };
      question?: string;
    },
  ): Promise<AssistOutcome> => orchestrator!.runAiRequest(auth, input, auth.meta);

  beforeAll(async () => {
    orchestrator = await tryImport<OrchestratorModule>('@/lib/ai/orchestrator');
    usage = await tryImport<UsageModule>('@/lib/ai/usage');
    fixtures = await tryImport<FixturesModule>('../authz/fixtures');
    authz = await tryImport<AuthzModule>('@/lib/authz/require-permission');
    if (!orchestrator || !usage || !fixtures || !authz) return;

    orgA = await fixtures.mkOrg(owner, `ai-a-${RUN.toLowerCase()}`);
    orgB = await fixtures.mkOrg(owner, `ai-b-${RUN.toLowerCase()}`);
    const deptA = await fixtures.mkDept(owner, orgA, 'A9A');
    const deptB = await fixtures.mkDept(owner, orgB, 'A9B');
    const roleA = await fixtures.mkCustomRole(owner, orgA, `A9A_${RUN}`, aiGrants());
    const roleB = await fixtures.mkCustomRole(owner, orgB, `A9B_${RUN}`, aiGrants());
    aliceAcct = await fixtures.mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'AliceA9',
      customRoles: [roleA],
    });
    bobAcct = await fixtures.mkAccount(owner, {
      org: orgB,
      dept: deptB,
      run: RUN,
      label: 'BobA9',
      customRoles: [roleB],
    });
    alice = aliceAcct.personId;

    companyA = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, name, industry, owner_person_id)
         values ($1,$2,$3,$4) returning id`,
        [orgA, `Acme ${TOK_A}`, `Fintech ${TOK_A}`, alice],
      )
    ).rows[0]!.id;

    await owner.query(`select public.seed_default_pipeline($1::uuid)`, [orgA]);
    const pipe = (
      await owner.query<{ id: string }>(
        `select p.id from public.pipelines p
         where p.org_id = $1 and p.is_default and p.deleted_at is null`,
        [orgA],
      )
    ).rows[0]!.id;
    const newStage = (
      await owner.query<{ id: string }>(
        `select s.id from public.pipeline_stages s where s.pipeline_id = $1 and s.name = 'NEW'`,
        [pipe],
      )
    ).rows[0]!.id;
    dealA = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id, company_id)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [orgA, `Deal ${TOK_A}`, alice, pipe, newStage, companyA],
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await owner.end().catch(() => undefined);
  });

  it('answers a company summary end-to-end with the mock provider', async () => {
    const auth = await authFor(aliceAcct, 'ai.use');
    const outcome = await run(auth, {
      capability: 'company_summary',
      target: { entityType: 'company', entityId: companyA },
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    // Grounded in the seeded record: the mock builds the headline from the
    // first context record's label — the company's run-unique name.
    expect(outcome.summary.headline).toContain(TOK_A);
    expect(JSON.stringify(outcome.summary.facts)).toContain(TOK_A);
    expect(outcome.sources).toContainEqual(
      expect.objectContaining({ entityType: 'company', entityId: companyA }),
    );
    expect(outcome.usage.provider).toBe('mock');
    expect(outcome.requestId).toBe(auth.requestId);
  });

  it('answers a deal summary for a NEW-stage deal (lead recipe)', async () => {
    const auth = await authFor(aliceAcct, 'ai.use');
    const outcome = await run(auth, {
      capability: 'lead_summary',
      target: { entityType: 'deal', entityId: dealA },
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.summary.headline).toContain(TOK_A);
    expect(outcome.sources).toContainEqual(
      expect.objectContaining({ entityType: 'deal', entityId: dealA }),
    );
  });

  it('writes exactly one usage row per request, with correct fields (§4.1)', async () => {
    const auth = await authFor(aliceAcct, 'ai.use');
    const outcome = await run(auth, {
      capability: 'company_summary',
      target: { entityType: 'company', entityId: companyA },
    });
    expect(outcome.status).toBe('ok');

    const rows = (
      await owner.query<{
        status: string;
        provider: string;
        model: string | null;
        capability: string;
        total_tokens: number | null;
        target_entity_id: string | null;
      }>(
        `select status, provider, model, capability, total_tokens, target_entity_id
         from public.ai_usage_requests where request_id = $1`,
        [auth.requestId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'SUCCEEDED',
      provider: 'mock',
      model: 'mock-deterministic',
      capability: 'company_summary',
      target_entity_id: companyA,
    });
    // The mock reports estimator counts — recorded because the provider
    // reported them; a real provider's NULL would stay NULL (§4.1).
    expect(rows[0]!.total_tokens).toBeGreaterThan(0);
  });

  it('writes the §4.3 audit entry for the request', async () => {
    const auth = await authFor(aliceAcct, 'ai.use');
    const outcome = await run(auth, {
      capability: 'company_summary',
      target: { entityType: 'company', entityId: companyA },
    });
    expect(outcome.status).toBe('ok');

    const usageRow = (
      await owner.query<{ id: string }>(
        `select id from public.ai_usage_requests where request_id = $1`,
        [auth.requestId],
      )
    ).rows[0]!;
    const audit = (
      await owner.query<{ action: string; entity_type: string; result: string }>(
        `select action, entity_type, result::text as result from public.audit_logs
         where request_id = $1 and action = 'ai.request'`,
        [auth.requestId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_type: 'ai_request', result: 'SUCCESS' });
    const entityIds = (
      await owner.query<{ entity_id: string | null }>(
        `select entity_id from public.audit_logs where request_id = $1 and action = 'ai.request'`,
        [auth.requestId],
      )
    ).rows;
    expect(entityIds[0]!.entity_id).toBe(usageRow.id);
  });

  it('refuses a cross-tenant target with NOT_FOUND (existence never leaks)', async () => {
    const authB = await authFor(bobAcct, 'ai.use');
    await expect(
      run(authB, {
        capability: 'company_summary',
        target: { entityType: 'company', entityId: companyA },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // …and no usage row is written for a request never authorized to see
    // its target (§5.5 step 5).
    const rows = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.ai_usage_requests where request_id = $1`,
        [authB.requestId],
      )
    ).rows;
    expect(rows[0]!.n).toBe(0);
  });

  it('serves the §8.3 usage reads: defaults first, aggregates after traffic', async () => {
    const auth = await authFor(aliceAcct, 'ai.usage.view');
    const limits = await usage!.readAiLimits(auth);
    expect(limits.raw).toBeNull();
    expect(limits.effective).toEqual({
      enabled: true,
      monthlyRequests: 5000,
      monthlyTokens: 2000000,
      requestsPerMinutePerUser: 10,
      maxConcurrentRequests: 4,
    });

    const summary = await usage!.getAiUsageSummary(auth);
    expect(summary.period).toMatch(/^\d{4}-\d{2}$/);
    expect(summary.succeeded).toBeGreaterThanOrEqual(3);
    expect(summary.requests).toBeGreaterThanOrEqual(summary.succeeded);
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.byCapability.map((b) => b.key)).toContain('company_summary');
    expect(summary.byProvider.map((b) => b.key)).toContain('mock');
  });

  it('limits every request when the org kill switch is off (§8.2)', async () => {
    const manageAuth = await authFor(aliceAcct, 'ai.usage.manage');
    await usage!.upsertAiOrgLimits(manageAuth, {
      enabled: false,
      monthlyRequestLimit: null,
      monthlyTokenLimit: null,
      maxRequestsPerMinutePerUser: null,
      maxConcurrentRequests: null,
    });
    try {
      const auth = await authFor(aliceAcct, 'ai.use');
      const outcome = await run(auth, {
        capability: 'company_summary',
        target: { entityType: 'company', entityId: companyA },
      });
      expect(outcome.status).toBe('limited');
      // The LIMITED visibility row exists but consumes no quota (§8.2).
      const rows = (
        await owner.query<{ status: string }>(
          `select status from public.ai_usage_requests where request_id = $1`,
          [auth.requestId],
        )
      ).rows;
      expect(rows).toEqual([{ status: 'LIMITED' }]);
    } finally {
      await usage!.upsertAiOrgLimits(manageAuth, {
        enabled: true,
        monthlyRequestLimit: null,
        monthlyTokenLimit: null,
        maxRequestsPerMinutePerUser: null,
        maxConcurrentRequests: null,
      });
    }
  });
});
