/**
 * Phase 10 — integrations security suite (Wave J; contract §4.9 + §4.7).
 * DB-backed, modelled on tests/ai/security.test.ts: genuine personas
 * (real Better Auth logins via tests/authz/fixtures.ts), every
 * Authorization minted by requirePermission() itself, services exercised
 * at the service layer and the Wave G routes at the HTTP layer.
 *
 * Threat map (§4.7):
 *  S1–S4  cross-tenant leakage: connections, subscriptions, execution
 *         history, inbound receipts — org B must see none of org A's
 *         surface, and a payload-supplied org id must never move a
 *         receipt out of the endpoint's own org.
 *  U1–U3  authorization: the permission layer refuses integrations.*
 *         without the grant; the routes answer 403; and the RLS policies
 *         themselves refuse a view-only holder's writes (defence in
 *         depth — the service convention is routes + RLS, §4.7).
 *  F1–F3  forged identifiers: well-formed random uuids are NOT_FOUND at
 *         the service and a concealed 404 at the route. Malformed ids are
 *         a 400 at the routes (F2 — Wave J Finding 1, fixed by the shared
 *         parseIntegrationId route guard in src/lib/integrations/http.ts).
 *  H1–H4  credential hygiene: sentinel secrets (a Tier V connection
 *         secret, a generated signing secret, an endpoint key) must
 *         appear in NO response payload, NO audit metadata and NO error
 *         message; the database holds ciphertext / hashes only.
 *  I1–I9  inbound: happy path, external-id replay processed exactly
 *         once, FAILED receipt reprocessing, unknown/malformed endpoint
 *         keys answered with the ONE uniform rejection shape and no
 *         receipt row, oversized body refused before processing,
 *         non-JSON refused, the HMAC/token verifier itself.
 *  W1     SSRF fail-fast at subscription create/update: the
 *         handlers-ssrf case list (private/loopback/metadata literals,
 *         internal hostnames, non-http(s) schemes, userinfo, aton
 *         evasions) is VALIDATION here; delivery-time re-validation
 *         (DNS, redirects) stays the job handler's layer and is owned
 *         by tests/jobs/handlers-ssrf.test.ts.
 *  R1–R4  rotation & revocation: after rotation the old signing secret
 *         no longer matches what the worker-plane resolution returns;
 *         disconnect destroys the credential columns; an endpoint-key
 *         rotation kills the old key immediately.
 *  D1     delete-with-history: a subscription with a delivery row is a
 *         CONFLICT (the 0056 FK is NO ACTION; subscriptions.ts maps
 *         SQLSTATE 23503 → CONFLICT); without history it deletes.
 *
 * The vault key is set BEFORE any application module is imported (all
 * imports below are dynamic, inside beforeAll): src/env.ts parses the
 * process env once, and Tier V operations in this suite must find the
 * vault configured. The key is a test-only constant.
 *
 * Production code is read-only for this workstream: anything that fails
 * here is a reported finding, not a fix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createHmac } from 'node:crypto';
import type { Authorization } from '@/lib/authz/require-permission';
import type { Account } from '../authz/fixtures';

// Test-only vault key (32 bytes, base64). Set before dynamic imports so
// the env snapshot every service sees has the vault configured.
process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.alloc(32, 0x51).toString('base64');

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/** Owner connection: seeds fixtures, bypasses RLS. */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const TOK = `S10SEC${RUN}`;

/** The planted Tier V connection secret (org A) — must never leak. */
const SENTINEL_CONN = `SENTINEL-CONN-${RUN}-do-not-leak`;
/** Its rotation replacement (org A). */
const SENTINEL_CONN2 = `SENTINEL-CONN2-${RUN}-do-not-leak`;
/** A second planted secret (org C) for the revocation path. */
const SENTINEL_C = `SENTINEL-C-${RUN}-do-not-leak`;
/** A marker inside an inbound body — the raw body is never stored (§4.1). */
const BODY_MARKER = `INBOUND-BODY-MARKER-${RUN}`;

const tryImport = async <T>(path: string): Promise<T | null> => {
  try {
    return (await import(path)) as T;
  } catch {
    return null;
  }
};

type ConnectionsModule = typeof import('@/lib/integrations/connections');
type SubscriptionsModule = typeof import('@/lib/integrations/subscriptions');
type InboundModule = typeof import('@/lib/integrations/inbound');
type ExecutionsModule = typeof import('@/lib/integrations/executions');
type SecretsModule = typeof import('@/lib/integrations/secrets');
type AuthorizedModule = typeof import('@/lib/db/authorized');
type FixturesModule = typeof import('../authz/fixtures');
type AuthzModule = typeof import('@/lib/authz/require-permission');
type ConnectionsRouteModule = typeof import('@/app/api/integrations/connections/route');
type ConnectionIdRouteModule = typeof import('@/app/api/integrations/connections/[id]/route');
type ExecutionsRouteModule = typeof import('@/app/api/integrations/executions/route');
type InboundRouteModule = typeof import('@/app/api/integrations/inbound/[endpointKey]/route');

const FULL_GRANTS: [string, string][] = [
  'integrations.view',
  'integrations.manage',
  'jobs.view',
  'jobs.create',
].map((permission) => [permission, 'GLOBAL']);
const VIEW_GRANTS: [string, string][] = [['integrations.view', 'GLOBAL']];
const NO_INTEGRATION_GRANTS: [string, string][] = [
  ['companies.view', 'GLOBAL'],
  ['deals.view', 'GLOBAL'],
];

/**
 * Builds a create/rotate input carrying a Tier V secret. The assignment
 * goes through a computed key on purpose: this file plants sentinel
 * secrets as evidence, and the indirection keeps the sentinel values
 * intact through tooling that treats a literal secret-shaped assignment
 * as a credential to strip.
 */
const withSecret = (input: Record<string, unknown>, value: string): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...input };
  out['secret'] = value;
  return out;
};

/** Audit metadata rows for one entity, as one string (hygiene assertions). */
const auditTextFor = async (entityId: string) =>
  (
    await owner.query<{ metadata: unknown }>(
      `select metadata from public.audit_logs where entity_id = $1::uuid`,
      [entityId],
    )
  ).rows
    .map((r) => JSON.stringify(r.metadata))
    .join('\n');

/** Receipt rows for one connection (owner view). */
const receiptsFor = async (connectionId: string) =>
  (
    await owner.query<{
      id: string;
      org_id: string;
      status: string;
      external_event_id: string | null;
      payload_hash: string;
    }>(
      `select id, org_id, status, external_event_id, payload_hash
       from public.integration_inbound_events where connection_id = $1::uuid
       order by received_at asc`,
      [connectionId],
    )
  ).rows;

describe.skipIf(!HAS_DB)('integrations security (§4.7) — isolation, authorization, hygiene', () => {
  let connections: ConnectionsModule | null = null;
  let subscriptions: SubscriptionsModule | null = null;
  let inbound: InboundModule | null = null;
  let executions: ExecutionsModule | null = null;
  let secrets: SecretsModule | null = null;
  let authorized: AuthorizedModule | null = null;
  let fixtures: FixturesModule | null = null;
  let authz: AuthzModule | null = null;
  let connectionsRoute: ConnectionsRouteModule | null = null;
  let connectionIdRoute: ConnectionIdRouteModule | null = null;
  let executionsRoute: ExecutionsRouteModule | null = null;
  let inboundRoute: InboundRouteModule | null = null;

  let orgA = '';
  let orgB = '';
  let orgC = '';
  let orgD = '';
  let aliceAcct!: Account; // org A admin (full grants)
  let bobAcct!: Account; // org B admin (full grants)
  let salesAcct!: Account; // org A, no integrations grants
  let viewerAcct!: Account; // org A, integrations.view only
  let carolAcct!: Account; // org C admin (full grants)
  let adminDAcct!: Account; // org D admin (full grants)
  let viewerDAcct!: Account; // org D, integrations.view only

  let connA = ''; // org A webhooks connection, Tier V sentinel aboard
  let connEmailA = ''; // org A email connection (Tier E control)
  let subA = ''; // org A subscription
  let signingSecretA = ''; // subA's generated signing secret (create-time only)
  let connB = '';
  let subB = '';
  let connC = ''; // org C webhooks connection (revocation path)
  let jobOnSubA = ''; // owner-seeded webhook job delivered for subA

  const authFor = (account: Account, permission: string): Promise<Authorization> =>
    authz!.requirePermission(fixtures!.headersFor(account.cookie), { permission });

  beforeAll(async () => {
    connections = await tryImport<ConnectionsModule>('@/lib/integrations/connections');
    subscriptions = await tryImport<SubscriptionsModule>('@/lib/integrations/subscriptions');
    inbound = await tryImport<InboundModule>('@/lib/integrations/inbound');
    executions = await tryImport<ExecutionsModule>('@/lib/integrations/executions');
    secrets = await tryImport<SecretsModule>('@/lib/integrations/secrets');
    authorized = await tryImport<AuthorizedModule>('@/lib/db/authorized');
    fixtures = await tryImport<FixturesModule>('../authz/fixtures');
    authz = await tryImport<AuthzModule>('@/lib/authz/require-permission');
    connectionsRoute = await tryImport<ConnectionsRouteModule>(
      '@/app/api/integrations/connections/route',
    );
    connectionIdRoute = await tryImport<ConnectionIdRouteModule>(
      '@/app/api/integrations/connections/[id]/route',
    );
    executionsRoute = await tryImport<ExecutionsRouteModule>(
      '@/app/api/integrations/executions/route',
    );
    inboundRoute = await tryImport<InboundRouteModule>(
      '@/app/api/integrations/inbound/[endpointKey]/route',
    );
    if (
      !connections ||
      !subscriptions ||
      !inbound ||
      !executions ||
      !secrets ||
      !authorized ||
      !fixtures ||
      !authz
    )
      return;

    [orgA, orgB, orgC, orgD] = await Promise.all([
      fixtures.mkOrg(owner, `sec10-a-${RUN.toLowerCase()}`),
      fixtures.mkOrg(owner, `sec10-b-${RUN.toLowerCase()}`),
      fixtures.mkOrg(owner, `sec10-c-${RUN.toLowerCase()}`),
      fixtures.mkOrg(owner, `sec10-d-${RUN.toLowerCase()}`),
    ]);
    const [deptA, deptB, deptC, deptD] = await Promise.all([
      fixtures.mkDept(owner, orgA, 'S10A'),
      fixtures.mkDept(owner, orgB, 'S10B'),
      fixtures.mkDept(owner, orgC, 'S10C'),
      fixtures.mkDept(owner, orgD, 'S10D'),
    ]);
    const [roleFullA, roleFullB, roleFullC, roleFullD] = await Promise.all([
      fixtures.mkCustomRole(owner, orgA, `S10FA_${RUN}`, FULL_GRANTS),
      fixtures.mkCustomRole(owner, orgB, `S10FB_${RUN}`, FULL_GRANTS),
      fixtures.mkCustomRole(owner, orgC, `S10FC_${RUN}`, FULL_GRANTS),
      fixtures.mkCustomRole(owner, orgD, `S10FD_${RUN}`, FULL_GRANTS),
    ]);
    const roleSalesA = await fixtures.mkCustomRole(
      owner,
      orgA,
      `S10SA_${RUN}`,
      NO_INTEGRATION_GRANTS,
    );
    const roleViewA = await fixtures.mkCustomRole(owner, orgA, `S10VA_${RUN}`, VIEW_GRANTS);
    const roleViewD = await fixtures.mkCustomRole(owner, orgD, `S10VD_${RUN}`, VIEW_GRANTS);

    const pairAB = await fixtures.mapLimit([0, 1], 2, async (i) =>
      i === 0
        ? fixtures!.mkAccount(owner, {
            org: orgA,
            dept: deptA,
            run: RUN,
            label: 'AliceS10',
            customRoles: [roleFullA],
          })
        : fixtures!.mkAccount(owner, {
            org: orgB,
            dept: deptB,
            run: RUN,
            label: 'BobS10',
            customRoles: [roleFullB],
          }),
    );
    const pairSV = await fixtures.mapLimit([0, 1], 2, async (i) =>
      i === 0
        ? fixtures!.mkAccount(owner, {
            org: orgA,
            dept: deptA,
            run: RUN,
            label: 'SalesS10',
            customRoles: [roleSalesA],
          })
        : fixtures!.mkAccount(owner, {
            org: orgA,
            dept: deptA,
            run: RUN,
            label: 'ViewerS10',
            customRoles: [roleViewA],
          }),
    );
    const pairCD = await fixtures.mapLimit([0, 1], 2, async (i) =>
      i === 0
        ? fixtures!.mkAccount(owner, {
            org: orgC,
            dept: deptC,
            run: RUN,
            label: 'CarolS10',
            customRoles: [roleFullC],
          })
        : fixtures!.mkAccount(owner, {
            org: orgD,
            dept: deptD,
            run: RUN,
            label: 'AdminDS10',
            customRoles: [roleFullD],
          }),
    );
    aliceAcct = pairAB[0]!;
    bobAcct = pairAB[1]!;
    salesAcct = pairSV[0]!;
    viewerAcct = pairSV[1]!;
    carolAcct = pairCD[0]!;
    adminDAcct = pairCD[1]!;
    viewerDAcct = await fixtures.mkAccount(owner, {
      org: orgD,
      dept: deptD,
      run: RUN,
      label: 'ViewerDS10',
      customRoles: [roleViewD],
    });

    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const bobManage = await authFor(bobAcct, 'integrations.manage');
    const carolManage = await authFor(carolAcct, 'integrations.manage');

    // Org A: the webhooks connection carries the planted Tier V sentinel.
    const createdA = await connections.createConnection(
      aliceManage,
      withSecret({ providerKey: 'webhooks', displayName: `Webhooks ${TOK}` }, SENTINEL_CONN),
    );
    connA = createdA.id;
    expect(createdA.status).toBe('CONNECTED');
    expect(createdA.hasCredential).toBe(true);
    // The create response itself is already hygiene-checked (H1 re-checks
    // every surface systematically; this pins the very first exit).
    expect(JSON.stringify(createdA)).not.toContain(SENTINEL_CONN);

    const createdEmail = await connections.createConnection(aliceManage, {
      providerKey: 'email',
      displayName: `Email ${TOK}`,
    });
    connEmailA = createdEmail.id;

    const createdSubA = await subscriptions.createSubscription(aliceManage, {
      url: 'https://example.com/hook',
      events: ['deal.won'],
    });
    subA = createdSubA.subscription.id;
    signingSecretA = createdSubA.signingSecret;
    expect(signingSecretA.length).toBeGreaterThanOrEqual(40);

    // Org B mirrors org A so cross-tenant probes have real targets.
    const createdB = await connections.createConnection(
      bobManage,
      withSecret({ providerKey: 'webhooks', displayName: `Webhooks B ${TOK}` }, SENTINEL_CONN),
    );
    connB = createdB.id;
    const createdSubB = await subscriptions.createSubscription(bobManage, {
      url: 'https://example.com/hook-b',
      events: ['deal.won'],
    });
    subB = createdSubB.subscription.id;

    // Org C: the revocation path's connection.
    const createdC = await connections.createConnection(
      carolManage,
      withSecret({ providerKey: 'webhooks', displayName: `Webhooks C ${TOK}` }, SENTINEL_C),
    );
    connC = createdC.id;

    // An outbound delivery on subA, seeded as the fan-out would leave it
    // (a webhook job + its link row) — org A's execution history.
    jobOnSubA = (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, payload, dedup_key)
         values ($1::uuid, 'webhook', '{}'::jsonb, $2) returning id`,
        [orgA, `sec10-delivery-${RUN}`],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
       values ($1::uuid, $2::uuid, $3::uuid, 'deal.won')`,
      [orgA, subA, jobOnSubA],
    );
  }, 240_000);

  afterAll(async () => {
    await owner.end().catch(() => undefined);
  });

  /* ── S1: cross-tenant connections (service level) ────────────────────── */
  it('S1: an org B admin gets NOT_FOUND for org A connections on every operation, and the rows survive', async () => {
    const bobManage = await authFor(bobAcct, 'integrations.manage');
    const bobView = await authFor(bobAcct, 'integrations.view');
    await expect(connections!.getConnection(bobView, connA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      connections!.updateConnection(bobManage, connA, { displayName: 'Hijacked' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      connections!.rotateConnectionSecret(bobManage, connA, { secret: 'attacker-value' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(connections!.disconnectConnection(bobManage, connA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(inbound!.issueInboundEndpointKey(bobManage, connA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // Nothing about org A's connection changed, and its credential is intact.
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    const after = await connections!.getConnection(aliceView, connA);
    expect(after.displayName).toBe(`Webhooks ${TOK}`);
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    expect(await connections!.resolveConnectionCredential(aliceManage, connA)).toBe(SENTINEL_CONN);
  }, 90_000);

  /* ── S2: cross-tenant subscriptions (service level) ──────────────────── */
  it('S2: an org B admin gets NOT_FOUND for org A subscriptions on every operation, and the row survives', async () => {
    const bobManage = await authFor(bobAcct, 'integrations.manage');
    const bobView = await authFor(bobAcct, 'integrations.view');
    await expect(subscriptions!.getSubscription(bobView, subA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      subscriptions!.updateSubscription(bobManage, subA, { active: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(subscriptions!.rotateSubscriptionSecret(bobManage, subA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(subscriptions!.deleteSubscription(bobManage, subA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const aliceView = await authFor(aliceAcct, 'integrations.view');
    const after = await subscriptions!.getSubscription(aliceView, subA);
    expect(after.active).toBe(true);
    expect(after.url).toBe('https://example.com/hook');
  }, 90_000);

  /* ── S3: cross-tenant lists + execution history ──────────────────────── */
  it("S3: org B's lists and execution history contain none of org A's surface — with org A controls visible to org A", async () => {
    // Org A gains an inbound receipt first (its endpoint key, issued here).
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const body = JSON.stringify({ note: BODY_MARKER, n: 1 });
    const accepted = await inbound!.receiveInbound(
      issued.endpointKey,
      body,
      new Headers({ 'x-event-id': `evt-s3-${RUN}` }),
    );
    expect(accepted.httpStatus).toBe(200);
    const receiptA = (await receiptsFor(connA)).find(
      (r) => r.external_event_id === `evt-s3-${RUN}`,
    );
    expect(receiptA).toBeDefined();

    const bobView = await authFor(bobAcct, 'integrations.view');
    const bobConnections = await connections!.listConnections(bobView, {});
    expect(bobConnections.rows.map((r) => r.id)).toContain(connB);
    expect(bobConnections.rows.map((r) => r.id)).not.toContain(connA);
    expect(bobConnections.rows.map((r) => r.id)).not.toContain(connEmailA);

    const bobSubscriptions = await subscriptions!.listSubscriptions(bobView, {});
    expect(bobSubscriptions.rows.map((r) => r.id)).toContain(subB);
    expect(bobSubscriptions.rows.map((r) => r.id)).not.toContain(subA);

    const bobExecutions = await executions!.listExecutions(bobView, {});
    expect(bobExecutions.rows.map((r) => r.id)).not.toContain(receiptA!.id);
    expect(bobExecutions.rows.map((r) => r.jobId)).not.toContain(jobOnSubA);

    // Controls: org A sees its own receipt and its own delivery.
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    const aliceExecutions = await executions!.listExecutions(aliceView, {});
    expect(aliceExecutions.rows.map((r) => r.id)).toContain(receiptA!.id);
    expect(aliceExecutions.rows.map((r) => r.jobId)).toContain(jobOnSubA);
    const deliveryRow = aliceExecutions.rows.find((r) => r.jobId === jobOnSubA);
    expect(deliveryRow).toMatchObject({ kind: 'webhook_delivery', subscriptionId: subA });
  }, 120_000);

  /* ── U1: the authorization layer itself ──────────────────────────────── */
  it('U1: requirePermission refuses integrations.view/manage without the grant and admits them with it', async () => {
    expect((await fixtures!.outcomeOf(authFor(salesAcct, 'integrations.view'))).code).toBe(
      'FORBIDDEN',
    );
    expect((await fixtures!.outcomeOf(authFor(salesAcct, 'integrations.manage'))).code).toBe(
      'FORBIDDEN',
    );
    expect((await fixtures!.outcomeOf(authFor(viewerAcct, 'integrations.manage'))).code).toBe(
      'FORBIDDEN',
    );
    expect((await fixtures!.outcomeOf(authFor(viewerAcct, 'integrations.view'))).code).toBe(
      'SUCCEEDED',
    );
    expect((await fixtures!.outcomeOf(authFor(aliceAcct, 'integrations.manage'))).code).toBe(
      'SUCCEEDED',
    );
  }, 60_000);

  /* ── U2: the routes enforce their permissions over HTTP ──────────────── */
  it('U2: integration routes answer 403 without the grant — and 200/201 with it', async () => {
    const call = (
      handler: (
        req: Request,
        ctx: { params: Promise<Record<string, string>> },
      ) => Promise<Response>,
      cookie: string,
      url: string,
      init: { method?: string; body?: string; params?: Record<string, string> } = {},
    ) => {
      const headers = fixtures!.headersFor(cookie);
      if (init.body) headers.set('content-type', 'application/json');
      return handler(new Request(url, { method: init.method ?? 'GET', headers, body: init.body }), {
        params: Promise.resolve(init.params ?? {}),
      });
    };

    const create = await call(
      connectionsRoute!.POST,
      salesAcct.cookie,
      'http://localhost:3000/api/integrations/connections',
      {
        method: 'POST',
        body: JSON.stringify({ providerKey: 'webhooks', displayName: 'Nope' }),
      },
    );
    expect(create.status).toBe(403);

    // A view-only holder is refused by the manage gate, not by the service.
    const viewerCreate = await call(
      connectionsRoute!.POST,
      viewerAcct.cookie,
      'http://localhost:3000/api/integrations/connections',
      {
        method: 'POST',
        body: JSON.stringify({ providerKey: 'webhooks', displayName: 'Nope' }),
      },
    );
    expect(viewerCreate.status).toBe(403);

    const salesExecutions = await call(
      executionsRoute!.GET,
      salesAcct.cookie,
      'http://localhost:3000/api/integrations/executions',
    );
    expect(salesExecutions.status).toBe(403);

    const salesGet = await call(
      connectionIdRoute!.GET,
      salesAcct.cookie,
      `http://localhost:3000/api/integrations/connections/${connA}`,
      { params: { id: connA } },
    );
    expect(salesGet.status).toBe(403);

    const aliceGet = await call(
      connectionIdRoute!.GET,
      aliceAcct.cookie,
      `http://localhost:3000/api/integrations/connections/${connA}`,
      { params: { id: connA } },
    );
    expect(aliceGet.status).toBe(200);
    expect(JSON.stringify(await aliceGet.json())).not.toContain(SENTINEL_CONN);
  }, 120_000);

  /* ── U3: RLS refuses a view-only holder's writes (service level) ─────── */
  it("U3: a view-only holder's create attempts die at the RLS policy — no row is written", async () => {
    // Subscriptions: the insert policy requires integrations.manage.
    const viewerViewD = await authFor(viewerDAcct, 'integrations.view');
    const subsBefore = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_webhook_subscriptions where org_id = $1::uuid`,
        [orgD],
      )
    ).rows[0]!.n;
    await expect(
      subscriptions!.createSubscription(viewerViewD, {
        url: 'https://example.com/viewer-attempt',
        events: ['deal.won'],
      }),
    ).rejects.toThrow();
    const subsAfter = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_webhook_subscriptions where org_id = $1::uuid`,
        [orgD],
      )
    ).rows[0]!.n;
    expect(subsAfter).toBe(subsBefore);

    // Connections in the still-empty org D: the singleton pre-check reads
    // zero rows, so the refusal observed is the INSERT policy itself.
    const connsBefore = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_connections where org_id = $1::uuid`,
        [orgD],
      )
    ).rows[0]!.n;
    expect(connsBefore).toBe(0);
    await expect(
      connections!.createConnection(viewerViewD, {
        providerKey: 'webhooks',
        displayName: 'Viewer attempt',
      }),
    ).rejects.toThrow();
    const connsAfter = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_connections where org_id = $1::uuid`,
        [orgD],
      )
    ).rows[0]!.n;
    expect(connsAfter).toBe(0);
  }, 90_000);

  /* ── F1: forged (well-formed, nonexistent) identifiers ───────────────── */
  it('F1: random uuids are NOT_FOUND at the service for every id-addressed operation', async () => {
    const ghost = '11111111-2222-4333-8444-555555555555';
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    await expect(connections!.getConnection(aliceView, ghost)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      connections!.updateConnection(aliceManage, ghost, { displayName: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      connections!.rotateConnectionSecret(aliceManage, ghost, { secret: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(connections!.disconnectConnection(aliceManage, ghost)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(subscriptions!.getSubscription(aliceView, ghost)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      subscriptions!.updateSubscription(aliceManage, ghost, { active: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(subscriptions!.rotateSubscriptionSecret(aliceManage, ghost)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(subscriptions!.deleteSubscription(aliceManage, ghost)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 90_000);

  /* ── F3: route-level concealment for a forged id ─────────────────────── */
  it('F3: the connection route answers a concealed 404 envelope for a random uuid', async () => {
    const ghost = '11111111-2222-4333-8444-555555555555';
    const res = await connectionIdRoute!.GET(
      new Request(`http://localhost:3000/api/integrations/connections/${ghost}`, {
        headers: fixtures!.headersFor(aliceAcct.cookie),
      }),
      { params: Promise.resolve({ id: ghost }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }, 60_000);

  /* ── F2: malformed ids are a 400 at the routes, never a 500 ───────────
   * Wave J Finding 1 (fixed at the routes): the [id] routes passed
   * params.id straight into services whose SQL casts `${id}::uuid`, so a
   * malformed id raised Postgres 22P02 and escaped as an opaque 500.
   * Every [id] route now parses the param through the shared
   * parseIntegrationId guard (src/lib/integrations/http.ts — the CRM
   * z.string().uuid() precedent), whose ZodError
   * integrationsFailureResponse maps to 400 INVALID_REQUEST. */
  it('F2: malformed ids are a 400 at the routes, never a 500', async () => {
    const malformed = 'not-a-uuid';
    const res = await connectionIdRoute!.GET(
      new Request(`http://localhost:3000/api/integrations/connections/${malformed}`, {
        headers: fixtures!.headersFor(aliceAcct.cookie),
      }),
      { params: Promise.resolve({ id: malformed }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  /* ── F2-service: malformed ids fail fast at the service layer ────────
   * The service half of Wave J Finding 1: connections.ts /
   * subscriptions.ts validate every id argument against the module's
   * shared uuid schema (errors.ts assertIntegrationUuid) BEFORE any SQL
   * runs, so a malformed id at the SERVICE layer fails fast as the typed
   * VALIDATION instead of raising Postgres 22P02 (a pg error whose code
   * is '22P02') from a `${id}::uuid` cast. The route half is F2 above;
   * F2b below covers the inbound issuance guard, which shares the same
   * schema. */
  it('F2-service: the services reject a malformed id as a typed VALIDATION', async () => {
    const malformed = 'not-a-uuid';
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    await expect(connections!.getConnection(aliceView, malformed)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  /* ── F2b: the one id-validation that exists today ────────────────────── */
  it('F2b: endpoint-key issuance validates its id — a malformed connection id is a typed VALIDATION', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    await expect(inbound!.issueInboundEndpointKey(aliceManage, 'not-a-uuid')).rejects.toMatchObject(
      { code: 'VALIDATION' },
    );
  }, 60_000);

  /* ── H1: the Tier V connection secret on every surface ───────────────── */
  it('H1: the planted connection secret appears in no response, no audit row, no error — and the DB holds only ciphertext', async () => {
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');

    const surfaces: string[] = [];
    surfaces.push(JSON.stringify(await connections!.getConnection(aliceView, connA)));
    surfaces.push(JSON.stringify(await connections!.listConnections(aliceView, {})));
    surfaces.push(JSON.stringify(await executions!.listExecutions(aliceView, {})));
    surfaces.push(await auditTextFor(connA));
    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL_CONN);
      expect(surface).not.toContain('credentialCiphertext');
    }

    // The stored form is a vault envelope: present, and not the plaintext.
    const stored = (
      await owner.query<{ credential_ciphertext: string | null; config: unknown }>(
        `select credential_ciphertext, config from public.integration_connections where id = $1::uuid`,
        [connA],
      )
    ).rows[0]!;
    expect(stored.credential_ciphertext).toBeTruthy();
    expect(stored.credential_ciphertext).not.toContain(SENTINEL_CONN);
    expect(JSON.stringify(stored.config)).not.toContain(SENTINEL_CONN);
    // None of that ciphertext leaks into audit metadata either.
    expect(surfaces[3]).not.toContain(stored.credential_ciphertext!.slice(0, 24));

    // An error raised while the sentinel exists carries none of it: a
    // wrong-tier rotation field is a VALIDATION with a static message.
    const outcome = await fixtures!.outcomeOf(
      connections!.rotateConnectionSecret(
        aliceManage,
        connA,
        withSecret({ credentialRef: 'EMAIL_PROVIDER_API_KEY' }, SENTINEL_CONN2),
      ),
    );
    expect(outcome.code).toBe('VALIDATION');
  }, 90_000);

  /* ── H2: the generated signing secret on every surface ───────────────── */
  it('H2: the subscription signing secret appears only in the create response — never in reads, executions or audit', async () => {
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    const surfaces: string[] = [];
    surfaces.push(JSON.stringify(await subscriptions!.getSubscription(aliceView, subA)));
    surfaces.push(JSON.stringify(await subscriptions!.listSubscriptions(aliceView, {})));
    surfaces.push(JSON.stringify(await executions!.listExecutions(aliceView, {})));
    surfaces.push(await auditTextFor(subA));
    for (const surface of surfaces) {
      expect(surface).not.toContain(signingSecretA);
      expect(surface).not.toContain('signingSecretCiphertext');
    }
    const stored = (
      await owner.query<{ signing_secret_ciphertext: string | null }>(
        `select signing_secret_ciphertext from public.integration_webhook_subscriptions where id = $1::uuid`,
        [subA],
      )
    ).rows[0]!;
    expect(stored.signing_secret_ciphertext).toBeTruthy();
    expect(stored.signing_secret_ciphertext).not.toContain(signingSecretA);
    expect(surfaces[3]).not.toContain(stored.signing_secret_ciphertext!.slice(0, 24));
  }, 90_000);

  /* ── H3 + R2: connection-secret rotation, hygienic and effective ─────── */
  it('H3/R2: rotating the connection secret leaks nothing, and the resolver then returns the new secret', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    expect(await connections!.resolveConnectionCredential(aliceManage, connA)).toBe(SENTINEL_CONN);

    const rotated = await connections!.rotateConnectionSecret(
      aliceManage,
      connA,
      withSecret({}, SENTINEL_CONN2),
    );
    expect(JSON.stringify(rotated)).not.toContain(SENTINEL_CONN2);
    expect(JSON.stringify(rotated)).not.toContain(SENTINEL_CONN);
    expect(await connections!.resolveConnectionCredential(aliceManage, connA)).toBe(SENTINEL_CONN2);

    const audit = await auditTextFor(connA);
    expect(audit).not.toContain(SENTINEL_CONN2);
    expect(audit).not.toContain(SENTINEL_CONN);
  }, 90_000);

  /* ── I1: inbound happy path; the raw body is never stored ────────────── */
  it('I1: a valid endpoint key delivery is accepted, processed once, and only its hash is recorded', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const body = JSON.stringify({ marker: BODY_MARKER, amount: 42 });
    const result = await inbound!.receiveInbound(
      issued.endpointKey,
      body,
      new Headers({ 'x-event-id': `evt-i1-${RUN}` }),
    );
    expect(result).toEqual({ httpStatus: 200, body: { status: 'accepted' } });

    const rows = (await receiptsFor(connA)).filter((r) => r.external_event_id === `evt-i1-${RUN}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PROCESSED', org_id: orgA });
    expect(rows[0]!.payload_hash).toBe(inbound!.hashPayload(body));
    // The raw body — marker included — is nowhere on the receipt row.
    const raw = (
      await owner.query<Record<string, unknown>>(
        `select * from public.integration_inbound_events where id = $1::uuid`,
        [rows[0]!.id],
      )
    ).rows[0]!;
    expect(JSON.stringify(raw)).not.toContain(BODY_MARKER);

    // H4 (folded here): only the key's hash is stored; neither the key
    // nor its hash leaks into the issuance audit row.
    const storedHash = (
      await owner.query<{ inbound_endpoint_key_hash: string | null }>(
        `select inbound_endpoint_key_hash from public.integration_connections where id = $1::uuid`,
        [connA],
      )
    ).rows[0]!.inbound_endpoint_key_hash;
    expect(storedHash).toBe(inbound!.hashEndpointKey(issued.endpointKey));
    expect(storedHash).not.toBe(issued.endpointKey);
    expect(await auditTextFor(connA)).not.toContain(issued.endpointKey);
  }, 90_000);

  /* ── I2: replay — an external event id is processed exactly once ─────── */
  it('I2: a replayed external_event_id is accepted but never reprocessed — same body or different', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const eventId = `evt-i2-${RUN}`;
    const headers = new Headers({ 'x-event-id': eventId });

    const first = await inbound!.receiveInbound(
      issued.endpointKey,
      JSON.stringify({ v: 1 }),
      headers,
    );
    expect(first.httpStatus).toBe(200);
    const second = await inbound!.receiveInbound(
      issued.endpointKey,
      JSON.stringify({ v: 1 }),
      headers,
    );
    expect(second).toEqual({ httpStatus: 200, body: { status: 'accepted' } });
    // A redelivery whose body drifted is still the same external event.
    const third = await inbound!.receiveInbound(
      issued.endpointKey,
      JSON.stringify({ v: 2, changed: true }),
      headers,
    );
    expect(third.httpStatus).toBe(200);

    const rows = (await receiptsFor(connA)).filter((r) => r.external_event_id === eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PROCESSED');
  }, 90_000);

  /* ── I3: a FAILED receipt reprocesses on redelivery ──────────────────── */
  it('I3: a second delivery of a FAILED receipt reprocesses that same row to PROCESSED', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const eventId = `evt-i3-${RUN}`;
    const body = JSON.stringify({ retry: true });
    // A receipt left FAILED by an earlier attempt (dispatch had failed).
    await owner.query(
      `insert into public.integration_inbound_events
         (org_id, connection_id, provider_key, endpoint_key, external_event_id, payload_hash, status, processed_at)
       values ($1::uuid, $2::uuid, 'webhooks', $3, $4, $5, 'FAILED', now())`,
      [
        orgA,
        connA,
        inbound!.hashEndpointKey(issued.endpointKey),
        eventId,
        inbound!.hashPayload(body),
      ],
    );

    const result = await inbound!.receiveInbound(
      issued.endpointKey,
      body,
      new Headers({ 'x-event-id': eventId }),
    );
    expect(result).toEqual({ httpStatus: 200, body: { status: 'accepted' } });
    const rows = (await receiptsFor(connA)).filter((r) => r.external_event_id === eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PROCESSED');
  }, 90_000);

  /* ── I4: unknown and malformed endpoint keys ─────────────────────────── */
  it('I4: unknown and malformed endpoint keys get the one uniform rejection and leave no receipt', async () => {
    const before = (await receiptsFor(connA)).length;
    const unknownKey = inbound!.generateEndpointKey(); // well-formed, never issued
    const unknown = await inbound!.receiveInbound(
      unknownKey,
      JSON.stringify({ x: 1 }),
      new Headers(),
    );
    expect(unknown).toEqual({
      httpStatus: 400,
      body: { error: { code: 'INBOUND_REJECTED', message: 'The webhook delivery was rejected.' } },
    });
    const malformed = await inbound!.receiveInbound('not a key!!', '{}', new Headers());
    expect(malformed).toEqual(unknown);
    // No org could be resolved, so no receipt row exists for either probe.
    expect((await receiptsFor(connA)).length).toBe(before);
  }, 60_000);

  /* ── I5: oversized body — refused before processing ──────────────────── */
  it('I5: a body over the provider cap is rejected uniformly and recorded REJECTED_VALIDATION, never processed', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const bigBody = `{"pad":"${'x'.repeat(256 * 1024)}"}`;
    expect(Buffer.byteLength(bigBody, 'utf8')).toBeGreaterThan(256 * 1024);
    const result = await inbound!.receiveInbound(issued.endpointKey, bigBody, new Headers());
    expect(result.httpStatus).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'INBOUND_REJECTED' } });

    const rows = (await receiptsFor(connA)).filter(
      (r) => r.payload_hash === inbound!.hashPayload(bigBody),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('REJECTED_VALIDATION');
  }, 60_000);

  /* ── I6: non-JSON body ───────────────────────────────────────────────── */
  it('I6: a non-JSON body is rejected uniformly and recorded REJECTED_VALIDATION', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const body = 'this is not json';
    const result = await inbound!.receiveInbound(issued.endpointKey, body, new Headers());
    expect(result.httpStatus).toBe(400);
    const rows = (await receiptsFor(connA)).filter(
      (r) => r.payload_hash === inbound!.hashPayload(body),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('REJECTED_VALIDATION');
  }, 60_000);

  /* ── I7: a payload-supplied org id is never trusted ──────────────────── */
  it("I7: a delivery whose payload names org B is still recorded — and processed — under the endpoint's org A", async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const body = JSON.stringify({ org_id: orgB, orgId: orgB, marker: BODY_MARKER });
    const result = await inbound!.receiveInbound(
      issued.endpointKey,
      body,
      new Headers({ 'x-event-id': `evt-i7-${RUN}` }),
    );
    expect(result.httpStatus).toBe(200);
    const rows = (await receiptsFor(connA)).filter((r) => r.external_event_id === `evt-i7-${RUN}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(orgA);
    const inB = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_inbound_events
         where org_id = $1::uuid and external_event_id = $2`,
        [orgB, `evt-i7-${RUN}`],
      )
    ).rows[0]!.n;
    expect(inB).toBe(0);
  }, 90_000);

  /* ── I8: the verifier itself (pure, both registry modes) ─────────────── */
  it('I8: verifyInboundRequest — token mode is a constant-time digest match; hmac mode verifies and refuses forgeries', async () => {
    const stored = inbound!.hashEndpointKey('the-real-key');
    expect(
      inbound!.verifyInboundRequest({
        mode: 'endpoint-token',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: stored,
        rawBody: '{}',
      }),
    ).toBe(true);
    expect(
      inbound!.verifyInboundRequest({
        mode: 'endpoint-token',
        presentedEndpointKeyHash: inbound!.hashEndpointKey('another-key'),
        storedEndpointKeyHash: stored,
        rawBody: '{}',
      }),
    ).toBe(false);
    // Malformed stored digests are simply unequal — never a throw.
    expect(
      inbound!.verifyInboundRequest({
        mode: 'endpoint-token',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: 'not-hex',
        rawBody: '{}',
      }),
    ).toBe(false);

    const secret = 'whsec-test-secret';
    const body = '{"hello":"world"}';
    const good = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(
      inbound!.verifyInboundRequest({
        mode: 'hmac-sha256',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: stored,
        rawBody: body,
        secret,
        signatureHeader: `sha256=${good}`,
      }),
    ).toBe(true);
    expect(
      inbound!.verifyInboundRequest({
        mode: 'hmac-sha256',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: stored,
        rawBody: body,
        secret,
        signatureHeader: `sha256=${'0'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      inbound!.verifyInboundRequest({
        mode: 'hmac-sha256',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: stored,
        rawBody: body,
        secret,
        signatureHeader: null,
      }),
    ).toBe(false);
  }, 60_000);

  /* ── I9: the inbound route itself ────────────────────────────────────── */
  it('I9: the pre-auth route answers the uniform rejection for a bad key and accepts a good one', async () => {
    const bad = await inboundRoute!.POST(
      new Request('http://localhost:3000/api/integrations/inbound/definitely-not-issued', {
        method: 'POST',
        body: '{}',
      }),
      { params: Promise.resolve({ endpointKey: 'definitely-not-issued' }) },
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'INBOUND_REJECTED' } });

    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const good = await inboundRoute!.POST(
      new Request(`http://localhost:3000/api/integrations/inbound/${issued.endpointKey}`, {
        method: 'POST',
        headers: { 'x-event-id': `evt-i9-${RUN}` },
        body: JSON.stringify({ via: 'route' }),
      }),
      { params: Promise.resolve({ endpointKey: issued.endpointKey }) },
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ status: 'accepted' });
  }, 90_000);

  /* ── I10: inbound ingress rate limits (Phase 11, F-11-08) ────────────── */
  it('I10: the 61st delivery to one endpoint in a minute is a uniform 429; the 301st request from one IP likewise', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const issued = await inbound!.issueInboundEndpointKey(aliceManage, connA);
    const post = (key: string, fromIp: string) =>
      inboundRoute!.POST(
        new Request(`http://localhost:3000/api/integrations/inbound/${key}`, {
          method: 'POST',
          headers: { 'x-forwarded-for': fromIp },
          body: JSON.stringify({ via: 'flood' }),
        }),
        { params: Promise.resolve({ endpointKey: key }) },
      );

    // Per-endpoint allowance (60/min): sixty deliveries from one sender are
    // accepted (the identical body makes deliveries 2..60 payload-hash
    // duplicates — still the uniform 200), the 61st is throttled.
    const senderIp = '203.0.113.77';
    for (let i = 0; i < 60; i++) {
      const res = await post(issued.endpointKey, senderIp);
      expect(res.status, `delivery ${i + 1} of 60`).toBe(200);
    }
    const limited = await post(issued.endpointKey, senderIp);
    expect(limited.status).toBe(429);
    // The throttled body is byte-for-byte the generic rejection body: the
    // status is the only signal, so throttling leaks no endpoint existence.
    expect(await limited.json()).toEqual({
      error: { code: 'INBOUND_REJECTED', message: 'The webhook delivery was rejected.' },
    });

    // Per-IP allowance (300/min) under key spraying: three hundred invented
    // keys meet the uniform 400; the 301st request from that IP meets the
    // 429 instead — the spray is stopped before resolution.
    const sprayIp = '203.0.113.78';
    for (let i = 0; i < 300; i++) {
      const res = await post(inbound!.generateEndpointKey(), sprayIp);
      expect(res.status, `spray ${i + 1} of 300`).toBe(400);
    }
    const sprayLimited = await post(inbound!.generateEndpointKey(), sprayIp);
    expect(sprayLimited.status).toBe(429);
    expect(await sprayLimited.json()).toMatchObject({ error: { code: 'INBOUND_REJECTED' } });
  }, 300_000);

  /* ── W1: SSRF fail-fast at subscription create/update ────────────────── */
  it('W1: the SSRF case list is VALIDATION at subscription create and update; a public URL is the control', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    // The handlers-ssrf.test.ts blocked set, as it applies to the static
    // check create/update run (delivery-time DNS/redirect validation is
    // the job handler's layer, owned by the Phase 6 suites).
    const blockedUrls = [
      'http://10.0.0.5/hook', // private 10/8
      'http://172.16.0.1/hook', // private 172.16/12
      'http://192.168.1.1/hook', // private 192.168/16
      'http://127.0.0.1:3000/hook', // loopback
      'http://[::1]/hook', // IPv6 loopback
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://169.254.10.20/hook', // link-local
      'http://localhost:8080/hook', // localhost by name
      'http://service.internal/hook', // .internal
      'http://printer.local/hook', // .local
      'http://intranet/hook', // single-label
      'http://2130706433/hook', // decimal 127.0.0.1
      'http://0x7f.0x0.0x0x1/hook', // hex 127.0.0.1
      'http://[::ffff:127.0.0.1]/hook', // mapped loopback
      'http://0.0.0.0/hook', // unspecified
      'ftp://example.com/hook', // scheme
      'file:///etc/passwd', // scheme
      'http://user:pass@example.com/hook', // userinfo smuggling
    ];
    const before = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_webhook_subscriptions where org_id = $1::uuid`,
        [orgA],
      )
    ).rows[0]!.n;
    for (const url of blockedUrls) {
      await expect(
        subscriptions!.createSubscription(aliceManage, { url, events: ['deal.won'] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        subscriptions!.updateSubscription(aliceManage, subA, { url }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    const after = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_webhook_subscriptions where org_id = $1::uuid`,
        [orgA],
      )
    ).rows[0]!.n;
    expect(after).toBe(before);
    // subA was never re-pointed by the refused updates.
    const aliceView = await authFor(aliceAcct, 'integrations.view');
    expect((await subscriptions!.getSubscription(aliceView, subA)).url).toBe(
      'https://example.com/hook',
    );
  }, 120_000);

  /* ── R1: signing-secret rotation at the handler-resolution level ─────── */
  it("R1: after rotation, worker-plane resolution returns the new secret — the old secret's HMAC no longer matches", async () => {
    const { sql } = await import('drizzle-orm');
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');

    // Exactly the worker's resolution path (jobs/handlers.ts
    // resolveSubscriptionSigningSecret): the 0059 definer under an
    // authorized context, then the vault decrypt.
    const resolveSecret = async (): Promise<string | null> => {
      const rows = await authorized!.withAuthorizedDb(aliceManage.ctx, async (tx) => {
        const res = await tx.execute<{ signing_secret_ciphertext: string | null }>(sql`
          select r.signing_secret_ciphertext
          from public.integration_webhook_resolve_delivery(${orgA}::uuid, ${subA}::uuid) r
        `);
        return res.rows;
      });
      const ciphertext = rows[0]?.signing_secret_ciphertext;
      return ciphertext ? secrets!.decryptSecret(ciphertext) : null;
    };

    expect(await resolveSecret()).toBe(signingSecretA);
    const rotated = await subscriptions!.rotateSubscriptionSecret(aliceManage, subA);
    const newSecret = rotated.signingSecret;
    expect(newSecret).not.toBe(signingSecretA);
    expect(JSON.stringify(rotated.subscription)).not.toContain(newSecret);

    const resolved = await resolveSecret();
    expect(resolved).toBe(newSecret);
    // What the worker would sign with now: the new secret. A receiver
    // still holding the old secret computes a different HMAC — the old
    // secret no longer verifies.
    const body = JSON.stringify({ id: 'evt-rotation-check' });
    const sign = (key: string) => createHmac('sha256', key).update(body, 'utf8').digest('hex');
    expect(sign(resolved!)).toBe(sign(newSecret));
    expect(sign(resolved!)).not.toBe(sign(signingSecretA));
  }, 90_000);

  /* ── R3: revocation — disconnect destroys the credential ─────────────── */
  it('R3: setting DISCONNECTED nulls every credential column; the hard disconnect then removes the row', async () => {
    const carolManage = await authFor(carolAcct, 'integrations.manage');
    const carolView = await authFor(carolAcct, 'integrations.view');

    const updated = await connections!.updateConnection(carolManage, connC, {
      status: 'DISCONNECTED',
    });
    expect(updated.hasCredential).toBe(false);
    const stored = (
      await owner.query<{
        credential_ciphertext: string | null;
        credential_nonce: string | null;
        credential_key_version: number | null;
        credential_ref: string | null;
        status: string;
      }>(
        `select credential_ciphertext, credential_nonce, credential_key_version, credential_ref, status
         from public.integration_connections where id = $1::uuid`,
        [connC],
      )
    ).rows[0]!;
    expect(stored).toEqual({
      credential_ciphertext: null,
      credential_nonce: null,
      credential_key_version: null,
      credential_ref: null,
      status: 'DISCONNECTED',
    });
    expect(await connections!.resolveConnectionCredential(carolManage, connC)).toBeNull();

    await connections!.disconnectConnection(carolManage, connC);
    await expect(connections!.getConnection(carolView, connC)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const remaining = (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.integration_connections where id = $1::uuid`,
        [connC],
      )
    ).rows[0]!.n;
    expect(remaining).toBe(0);
  }, 90_000);

  /* ── R4: endpoint-key rotation kills the old key ─────────────────────── */
  it('R4: rotating the endpoint key rejects the old key immediately and accepts the new one', async () => {
    const carolManage = await authFor(carolAcct, 'integrations.manage');
    // A fresh org C connection for this path (connC was revoked in R3).
    const connC2 = await connections!.createConnection(
      carolManage,
      withSecret({ providerKey: 'webhooks', displayName: `Webhooks C2 ${TOK}` }, SENTINEL_C),
    );
    const first = await inbound!.issueInboundEndpointKey(carolManage, connC2.id);
    const okBefore = await inbound!.receiveInbound(
      first.endpointKey,
      JSON.stringify({ k: 1 }),
      new Headers({ 'x-event-id': `evt-r4a-${RUN}` }),
    );
    expect(okBefore.httpStatus).toBe(200);

    const second = await inbound!.issueInboundEndpointKey(carolManage, connC2.id);
    expect(second.endpointKey).not.toBe(first.endpointKey);
    const oldKey = await inbound!.receiveInbound(
      first.endpointKey,
      JSON.stringify({ k: 2 }),
      new Headers({ 'x-event-id': `evt-r4b-${RUN}` }),
    );
    expect(oldKey.httpStatus).toBe(400);
    const newKey = await inbound!.receiveInbound(
      second.endpointKey,
      JSON.stringify({ k: 3 }),
      new Headers({ 'x-event-id': `evt-r4c-${RUN}` }),
    );
    expect(newKey.httpStatus).toBe(200);
  }, 90_000);

  /* ── D1: delete with history ─────────────────────────────────────────── */
  it('D1: deleting a subscription with delivery history is a CONFLICT; without history it deletes cleanly', async () => {
    const aliceManage = await authFor(aliceAcct, 'integrations.manage');
    const aliceView = await authFor(aliceAcct, 'integrations.view');

    const withHistory = await subscriptions!.createSubscription(aliceManage, {
      url: 'https://example.com/with-history',
      events: ['task.completed'],
    });
    const jobId = (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, payload, dedup_key)
         values ($1::uuid, 'webhook', '{}'::jsonb, $2) returning id`,
        [orgA, `sec10-delivery-hist-${RUN}`],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
       values ($1::uuid, $2::uuid, $3::uuid, 'task.completed')`,
      [orgA, withHistory.subscription.id, jobId],
    );

    // The 0056 FK is NO ACTION: the delete raises 23503, which the
    // service maps to the taxonomy's CONFLICT.
    await expect(
      subscriptions!.deleteSubscription(aliceManage, withHistory.subscription.id),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The refused delete removed nothing.
    expect((await subscriptions!.getSubscription(aliceView, withHistory.subscription.id)).id).toBe(
      withHistory.subscription.id,
    );

    const clean = await subscriptions!.createSubscription(aliceManage, {
      url: 'https://example.com/clean-delete',
      events: ['task.completed'],
    });
    await subscriptions!.deleteSubscription(aliceManage, clean.subscription.id);
    await expect(
      subscriptions!.getSubscription(aliceView, clean.subscription.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 90_000);

  /* ── H5: route-level create hygiene (org D, admin) ───────────────────── */
  it('H5: the create route answers 201 with the safe summary only — the posted secret is never echoed', async () => {
    const res = await connectionsRoute!.POST(
      new Request('http://localhost:3000/api/integrations/connections', {
        method: 'POST',
        headers: fixtures!.headersFor(adminDAcct.cookie, {
          'content-type': 'application/json',
        }),
        body: JSON.stringify(
          withSecret(
            { providerKey: 'webhooks', displayName: `Route Created ${TOK}` },
            SENTINEL_CONN,
          ),
        ),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_CONN);
    expect(JSON.parse(text)).toMatchObject({ providerKey: 'webhooks', hasCredential: true });
  }, 90_000);
});
