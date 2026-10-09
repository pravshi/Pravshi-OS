/**
 * Phase 10 — integrations RLS matrix (Wave J; contract §4.7, §4.9).
 *
 * The raw-policy companion to tests/db/integrations-schema.test.ts (the
 * schema's shape) and tests/integrations/security.test.ts (the service
 * layer): here every statement runs as app_user (DATABASE_URL_TEST)
 * inside a transaction whose GUCs name a genuine fixture person + org —
 * the same identity the runtime sets via withAuthorizedDb — so what is
 * measured is the 0056 policies and triggers themselves, not a service.
 *
 * The matrix, per table (0056):
 *  - cross-tenant SELECT returns zero rows; INSERT naming the other org
 *    is refused 42501; UPDATE/DELETE of the other org's rows touch zero
 *    rows and leave them intact — for all five tables;
 *  - the permission gates hold inside one org: SELECT needs
 *    integrations.view, writes on connections/subscriptions/checkpoints
 *    need integrations.manage, while deliveries INSERT and inbound
 *    INSERT/UPDATE are tenant-only (the fan-out / pre-auth precedents);
 *  - the identity-freeze triggers raise 23514 on every frozen column;
 *    deliveries are append-only (no app_user UPDATE/DELETE policy at
 *    all, and the freeze trigger backstops even the owner);
 *  - the 0058/0059 SECURITY DEFINER reads return rows only for the
 *    exact endpoint-key hash / (org, subscription) pair they name;
 *  - the W-in write shape works: a resolved-org context with NO person
 *    identity (nil UUID) and no integrations.* grants can insert and
 *    transition inbound receipts in its own org — and nothing else.
 *
 * People are fixture people (tests/authz/fixtures.ts mkPerson +
 * mkEngagement + custom roles) — no logins are needed at this layer,
 * because authz.has() reads the same person_roles the fixtures write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const TOK = `S10RLS${RUN}`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** 64-hex stand-ins for an endpoint-key hash / a payload hash. */
const KEYHASH_A = 'a1'.repeat(32);
const KEYHASH_B = 'b2'.repeat(32);
const PAYHASH_A = 'c3'.repeat(32);
const PAYHASH_B = 'd4'.repeat(32);

const tryImport = async <T>(path: string): Promise<T | null> => {
  try {
    return (await import(path)) as T;
  } catch {
    return null;
  }
};

type FixturesModule = typeof import('../authz/fixtures');

type Ctx = { personId: string; orgId: string };

/**
 * One statement as app_user under a fixture identity (the tests/work
 * inContext pattern): a transaction with the app.* GUCs the runtime
 * would set, rolled back on error so a refused statement ends cleanly.
 */
async function inCtx<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const client = await asUser.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.person_id', $1, true),
              set_config('app.org_id', $2, true),
              set_config('app.aal', 'aal1', true)`,
      [ctx.personId, ctx.orgId],
    );
    const result = await client.query<T>(text, params);
    await client.query('commit');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The SQLSTATE a statement was refused with (raw pool: code rides the error). */
async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'SUCCEEDED';
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? 'UNKNOWN';
  }
}

const FULL_GRANTS: [string, string][] = [
  ['integrations.view', 'GLOBAL'],
  ['integrations.manage', 'GLOBAL'],
  ['jobs.view', 'GLOBAL'],
];
const VIEW_GRANTS: [string, string][] = [['integrations.view', 'GLOBAL']];
const NO_INTEGRATION_GRANTS: [string, string][] = [['companies.view', 'GLOBAL']];

describe.skipIf(!HAS_DB)('integrations RLS (§4.7) — the 0056 policy matrix', () => {
  let orgA = '';
  let orgB = '';
  let alice = ''; // org A, view+manage
  let bob = ''; // org B, view+manage
  let viewer = ''; // org A, view only
  let noGrant = ''; // org A, no integrations grants

  let connA = '';
  let connB = '';
  let subA = '';
  let subB = '';
  let jobA = '';
  let jobB = '';
  let deliveryA = '';
  let deliveryB = '';
  let inboundA = '';
  let inboundB = '';
  let checkpointA = '';
  let checkpointB = '';

  const aliceCtx = (): Ctx => ({ personId: alice, orgId: orgA });
  const bobCtx = (): Ctx => ({ personId: bob, orgId: orgB });
  const viewerCtx = (): Ctx => ({ personId: viewer, orgId: orgA });
  const noGrantCtx = (): Ctx => ({ personId: noGrant, orgId: orgA });
  /** The W-in resolved-org context: an org, no person (§4.4). */
  const resolvedCtxA = (): Ctx => ({ personId: NIL_UUID, orgId: orgA });

  const countAs = async (ctx: Ctx, table: string, id: string) =>
    (
      await inCtx<{ n: number }>(
        ctx,
        `select count(*)::int n from public.${table} where id = $1::uuid`,
        [id],
      )
    ).rows[0]!.n;

  const ownerCount = async (table: string, id: string) =>
    (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.${table} where id = $1::uuid`,
        [id],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    const fixtures = await tryImport<FixturesModule>('../authz/fixtures');
    if (!fixtures) return;

    [orgA, orgB] = await Promise.all([
      fixtures.mkOrg(owner, `rls10-a-${RUN.toLowerCase()}`),
      fixtures.mkOrg(owner, `rls10-b-${RUN.toLowerCase()}`),
    ]);
    const [deptA, deptB] = await Promise.all([
      fixtures.mkDept(owner, orgA, 'R10A'),
      fixtures.mkDept(owner, orgB, 'R10B'),
    ]);
    [alice, bob, viewer, noGrant] = await Promise.all([
      fixtures.mkPerson(owner, orgA, `Alice ${TOK}`),
      fixtures.mkPerson(owner, orgB, `Bob ${TOK}`),
      fixtures.mkPerson(owner, orgA, `Viewer ${TOK}`),
      fixtures.mkPerson(owner, orgA, `NoGrant ${TOK}`),
    ]);
    await Promise.all([
      fixtures.mkEngagement(owner, orgA, alice, deptA),
      fixtures.mkEngagement(owner, orgB, bob, deptB),
      fixtures.mkEngagement(owner, orgA, viewer, deptA),
      fixtures.mkEngagement(owner, orgA, noGrant, deptA),
    ]);
    const [roleFullA, roleFullB, roleViewA, roleNoneA] = await Promise.all([
      fixtures.mkCustomRole(owner, orgA, `R10FA_${RUN}`, FULL_GRANTS),
      fixtures.mkCustomRole(owner, orgB, `R10FB_${RUN}`, FULL_GRANTS),
      fixtures.mkCustomRole(owner, orgA, `R10VA_${RUN}`, VIEW_GRANTS),
      fixtures.mkCustomRole(owner, orgA, `R10NA_${RUN}`, NO_INTEGRATION_GRANTS),
    ]);
    await Promise.all([
      fixtures.assignRoleId(owner, alice, orgA, roleFullA),
      fixtures.assignRoleId(owner, bob, orgB, roleFullB),
      fixtures.assignRoleId(owner, viewer, orgA, roleViewA),
      fixtures.assignRoleId(owner, noGrant, orgA, roleNoneA),
    ]);

    // Seed one row per table per org, as the owner (the services' writes
    // are covered by the security suite; here the rows are probe targets).
    const insert = async <T extends Record<string, unknown>>(
      text: string,
      params: unknown[],
    ): Promise<string> => (await owner.query<T & { id: string }>(text, params)).rows[0]!.id;

    connA = await insert(
      `insert into public.integration_connections
         (org_id, provider_key, display_name, status, config, connected_by, inbound_endpoint_key_hash)
       values ($1::uuid, 'webhooks', $2, 'CONNECTED', '{}'::jsonb, $3::uuid, $4) returning id`,
      [orgA, `Conn A ${TOK}`, alice, KEYHASH_A],
    );
    connB = await insert(
      `insert into public.integration_connections
         (org_id, provider_key, display_name, status, config, connected_by, inbound_endpoint_key_hash)
       values ($1::uuid, 'webhooks', $2, 'CONNECTED', '{}'::jsonb, $3::uuid, $4) returning id`,
      [orgB, `Conn B ${TOK}`, bob, KEYHASH_B],
    );
    subA = await insert(
      `insert into public.integration_webhook_subscriptions
         (org_id, url, events, active, signing_secret_ciphertext, created_by)
       values ($1::uuid, 'https://example.com/a', '{deal.won}'::text[], true, $2, $3::uuid) returning id`,
      [orgA, `ciphertext-a-${RUN}`, alice],
    );
    subB = await insert(
      `insert into public.integration_webhook_subscriptions
         (org_id, url, events, active, signing_secret_ciphertext, created_by)
       values ($1::uuid, 'https://example.com/b', '{deal.won}'::text[], true, $2, $3::uuid) returning id`,
      [orgB, `ciphertext-b-${RUN}`, bob],
    );
    jobA = await insert(
      `insert into public.jobs (org_id, type, payload, dedup_key)
       values ($1::uuid, 'webhook', '{}'::jsonb, $2) returning id`,
      [orgA, `rls10-job-a-${RUN}`],
    );
    jobB = await insert(
      `insert into public.jobs (org_id, type, payload, dedup_key)
       values ($1::uuid, 'webhook', '{}'::jsonb, $2) returning id`,
      [orgB, `rls10-job-b-${RUN}`],
    );
    deliveryA = await insert(
      `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
       values ($1::uuid, $2::uuid, $3::uuid, 'deal.won') returning id`,
      [orgA, subA, jobA],
    );
    deliveryB = await insert(
      `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
       values ($1::uuid, $2::uuid, $3::uuid, 'deal.won') returning id`,
      [orgB, subB, jobB],
    );
    inboundA = await insert(
      `insert into public.integration_inbound_events
         (org_id, connection_id, provider_key, endpoint_key, external_event_id, payload_hash, status, processed_at)
       values ($1::uuid, $2::uuid, 'webhooks', $3, $4, $5, 'PROCESSED', now()) returning id`,
      [orgA, connA, KEYHASH_A, `rls-evt-a-${RUN}`, PAYHASH_A],
    );
    inboundB = await insert(
      `insert into public.integration_inbound_events
         (org_id, connection_id, provider_key, endpoint_key, external_event_id, payload_hash, status, processed_at)
       values ($1::uuid, $2::uuid, 'webhooks', $3, $4, $5, 'PROCESSED', now()) returning id`,
      [orgB, connB, KEYHASH_B, `rls-evt-b-${RUN}`, PAYHASH_B],
    );
    checkpointA = await insert(
      `insert into public.integration_sync_checkpoints (org_id, connection_id, resource, cursor)
       values ($1::uuid, $2::uuid, 'deals', 'cursor-a') returning id`,
      [orgA, connA],
    );
    checkpointB = await insert(
      `insert into public.integration_sync_checkpoints (org_id, connection_id, resource, cursor)
       values ($1::uuid, $2::uuid, 'deals', 'cursor-b') returning id`,
      [orgB, connB],
    );
  }, 240_000);

  afterAll(async () => {
    await owner.end().catch(() => undefined);
    await asUser.end().catch(() => undefined);
  });

  /* ── Cross-tenant matrix, table by table ─────────────────────────────── */

  it('connections: org B is invisible and untouchable from org A — and the control reads work', async () => {
    const ctx = aliceCtx();
    expect(await countAs(ctx, 'integration_connections', connA)).toBe(1);
    expect(await countAs(ctx, 'integration_connections', connB)).toBe(0);
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `insert into public.integration_connections
             (org_id, provider_key, display_name, status, config, connected_by)
           values ($1::uuid, 'webhooks', 'Forged', 'CONNECTED', '{}'::jsonb, $2::uuid)`,
          [orgB, alice],
        ),
      ),
    ).toBe('42501');
    const upd = await inCtx(
      ctx,
      `update public.integration_connections set display_name = 'Hijacked' where id = $1::uuid`,
      [connB],
    );
    expect(upd.rowCount).toBe(0);
    const del = await inCtx(ctx, `delete from public.integration_connections where id = $1::uuid`, [
      connB,
    ]);
    expect(del.rowCount).toBe(0);
    expect(await ownerCount('integration_connections', connB)).toBe(1);
    // Symmetric spot check from org B's side.
    expect(await countAs(bobCtx(), 'integration_connections', connA)).toBe(0);
  }, 60_000);

  it('subscriptions: org B is invisible and untouchable from org A', async () => {
    const ctx = aliceCtx();
    expect(await countAs(ctx, 'integration_webhook_subscriptions', subA)).toBe(1);
    expect(await countAs(ctx, 'integration_webhook_subscriptions', subB)).toBe(0);
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `insert into public.integration_webhook_subscriptions (org_id, url, events, created_by)
           values ($1::uuid, 'https://example.com/forged', '{deal.won}'::text[], $2::uuid)`,
          [orgB, alice],
        ),
      ),
    ).toBe('42501');
    const upd = await inCtx(
      ctx,
      `update public.integration_webhook_subscriptions set active = false where id = $1::uuid`,
      [subB],
    );
    expect(upd.rowCount).toBe(0);
    const del = await inCtx(
      ctx,
      `delete from public.integration_webhook_subscriptions where id = $1::uuid`,
      [subB],
    );
    expect(del.rowCount).toBe(0);
    expect(await ownerCount('integration_webhook_subscriptions', subB)).toBe(1);
  }, 60_000);

  it('deliveries: cross-tenant rows are invisible; inserts naming org B are refused', async () => {
    const ctx = aliceCtx();
    expect(await countAs(ctx, 'integration_webhook_deliveries', deliveryA)).toBe(1);
    expect(await countAs(ctx, 'integration_webhook_deliveries', deliveryB)).toBe(0);
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
           values ($1::uuid, $2::uuid, $3::uuid, 'deal.won')`,
          [orgB, subB, jobB],
        ),
      ),
    ).toBe('42501');
    const del = await inCtx(
      ctx,
      `delete from public.integration_webhook_deliveries where id = $1::uuid`,
      [deliveryB],
    );
    expect(del.rowCount).toBe(0);
    expect(await ownerCount('integration_webhook_deliveries', deliveryB)).toBe(1);
  }, 60_000);

  it('inbound events: cross-tenant rows are invisible; inserts naming org B are refused; deletes touch nothing', async () => {
    const ctx = aliceCtx();
    expect(await countAs(ctx, 'integration_inbound_events', inboundA)).toBe(1);
    expect(await countAs(ctx, 'integration_inbound_events', inboundB)).toBe(0);
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `insert into public.integration_inbound_events
             (org_id, connection_id, provider_key, endpoint_key, external_event_id, payload_hash, status)
           values ($1::uuid, $2::uuid, 'webhooks', $3, $4, $5, 'RECEIVED')`,
          [orgB, connB, KEYHASH_B, `rls-forged-${RUN}`, PAYHASH_B],
        ),
      ),
    ).toBe('42501');
    const upd = await inCtx(
      ctx,
      `update public.integration_inbound_events set status = 'FAILED' where id = $1::uuid`,
      [inboundB],
    );
    expect(upd.rowCount).toBe(0);
    // No DELETE policy for app_user at all — even org A's own receipts stay.
    const del = await inCtx(
      ctx,
      `delete from public.integration_inbound_events where id = $1::uuid`,
      [inboundA],
    );
    expect(del.rowCount).toBe(0);
    expect(await ownerCount('integration_inbound_events', inboundA)).toBe(1);
    expect(await ownerCount('integration_inbound_events', inboundB)).toBe(1);
  }, 60_000);

  it('checkpoints: cross-tenant rows are invisible; inserts naming org B are refused; deletes touch nothing', async () => {
    const ctx = aliceCtx();
    expect(await countAs(ctx, 'integration_sync_checkpoints', checkpointA)).toBe(1);
    expect(await countAs(ctx, 'integration_sync_checkpoints', checkpointB)).toBe(0);
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `insert into public.integration_sync_checkpoints (org_id, connection_id, resource)
           values ($1::uuid, $2::uuid, 'deals')`,
          [orgB, connB],
        ),
      ),
    ).toBe('42501');
    const upd = await inCtx(
      ctx,
      `update public.integration_sync_checkpoints set cursor = 'hijacked' where id = $1::uuid`,
      [checkpointB],
    );
    expect(upd.rowCount).toBe(0);
    // No DELETE policy for app_user (checkpoints die with their connection, via the owner).
    const del = await inCtx(
      ctx,
      `delete from public.integration_sync_checkpoints where id = $1::uuid`,
      [checkpointA],
    );
    expect(del.rowCount).toBe(0);
    expect(await ownerCount('integration_sync_checkpoints', checkpointA)).toBe(1);
  }, 60_000);

  /* ── Permission gates inside one org ─────────────────────────────────── */

  it('gates: view-only can read but not write; no-grant cannot even read', async () => {
    // View-only, own org.
    expect(await countAs(viewerCtx(), 'integration_connections', connA)).toBe(1);
    expect(
      await sqlstateOf(
        inCtx(
          viewerCtx(),
          `insert into public.integration_connections
             (org_id, provider_key, display_name, status, config, connected_by)
           values ($1::uuid, 'email', 'Viewer attempt', 'CONNECTED', '{}'::jsonb, $2::uuid)`,
          [orgA, viewer],
        ),
      ),
    ).toBe('42501');
    const upd = await inCtx(
      viewerCtx(),
      `update public.integration_connections set display_name = 'Viewer edit' where id = $1::uuid`,
      [connA],
    );
    expect(upd.rowCount).toBe(0);
    const del = await inCtx(
      viewerCtx(),
      `delete from public.integration_connections where id = $1::uuid`,
      [connA],
    );
    expect(del.rowCount).toBe(0);

    // No integrations grants at all: the SELECT policies hide everything.
    expect(await countAs(noGrantCtx(), 'integration_connections', connA)).toBe(0);
    expect(await countAs(noGrantCtx(), 'integration_webhook_subscriptions', subA)).toBe(0);
    expect(await countAs(noGrantCtx(), 'integration_inbound_events', inboundA)).toBe(0);
    expect(await countAs(noGrantCtx(), 'integration_sync_checkpoints', checkpointA)).toBe(0);
    expect(await countAs(noGrantCtx(), 'integration_webhook_deliveries', deliveryA)).toBe(0);
  }, 60_000);

  /* ── Identity freeze triggers (23514) ────────────────────────────────── */

  it('freeze: connections identity columns raise 23514; ordinary fields stay mutable', async () => {
    const ctx = aliceCtx();
    for (const [column, value] of [
      ['org_id', orgB],
      ['provider_key', 'email'],
      ['connected_by', bob],
    ] as const) {
      expect(
        await sqlstateOf(
          inCtx(
            ctx,
            `update public.integration_connections set ${column} = $1 where id = $2::uuid`,
            [value, connA],
          ),
        ),
      ).toBe('23514');
    }
    const ok = await inCtx(
      ctx,
      `update public.integration_connections set display_name = $1 where id = $2::uuid`,
      [`Renamed ${TOK}`, connA],
    );
    expect(ok.rowCount).toBe(1);
  }, 60_000);

  it('freeze: subscriptions identity columns raise 23514; url stays mutable', async () => {
    const ctx = aliceCtx();
    for (const [column, value] of [
      ['org_id', orgB],
      ['created_by', bob],
    ] as const) {
      expect(
        await sqlstateOf(
          inCtx(
            ctx,
            `update public.integration_webhook_subscriptions set ${column} = $1 where id = $2::uuid`,
            [value, subA],
          ),
        ),
      ).toBe('23514');
    }
    const ok = await inCtx(
      ctx,
      `update public.integration_webhook_subscriptions set url = $1 where id = $2::uuid`,
      ['https://example.com/a-renamed', subA],
    );
    expect(ok.rowCount).toBe(1);
  }, 60_000);

  it('freeze: checkpoints identity columns raise 23514; cursor stays mutable', async () => {
    const ctx = aliceCtx();
    for (const [column, value] of [
      ['org_id', orgB],
      ['connection_id', connB],
      ['resource', 'contacts'],
    ] as const) {
      expect(
        await sqlstateOf(
          inCtx(
            ctx,
            `update public.integration_sync_checkpoints set ${column} = $1 where id = $2::uuid`,
            [value, checkpointA],
          ),
        ),
      ).toBe('23514');
    }
    const ok = await inCtx(
      ctx,
      `update public.integration_sync_checkpoints set cursor = 'cursor-a2' where id = $1::uuid`,
      [checkpointA],
    );
    expect(ok.rowCount).toBe(1);
  }, 60_000);

  it('freeze: inbound identity columns raise 23514; status transitions stay open (tenant-only update)', async () => {
    const ctx = aliceCtx();
    for (const [column, value] of [
      ['org_id', orgB],
      ['connection_id', connB],
      ['provider_key', 'email'],
      ['endpoint_key', KEYHASH_B],
      ['external_event_id', `rls-evt-forged-${RUN}`],
      ['payload_hash', PAYHASH_B],
    ] as const) {
      expect(
        await sqlstateOf(
          inCtx(
            ctx,
            `update public.integration_inbound_events set ${column} = $1 where id = $2::uuid`,
            [value, inboundA],
          ),
        ),
      ).toBe('23514');
    }
    const ok = await inCtx(
      ctx,
      `update public.integration_inbound_events set status = 'FAILED' where id = $1::uuid`,
      [inboundA],
    );
    expect(ok.rowCount).toBe(1);
    // Restore for later readers.
    await inCtx(
      ctx,
      `update public.integration_inbound_events set status = 'PROCESSED' where id = $1::uuid`,
      [inboundA],
    );
  }, 60_000);

  it('deliveries are append-only: no app_user update/delete path, and the freeze trigger backstops even the owner', async () => {
    const ctx = aliceCtx();
    const upd = await inCtx(
      ctx,
      `update public.integration_webhook_deliveries set event_key = 'deal.lost' where id = $1::uuid`,
      [deliveryA],
    );
    expect(upd.rowCount).toBe(0);
    const del = await inCtx(
      ctx,
      `delete from public.integration_webhook_deliveries where id = $1::uuid`,
      [deliveryA],
    );
    expect(del.rowCount).toBe(0);
    // The owner bypasses RLS but not triggers: the row is frozen for
    // everyone (purges run through a cleanup path, not an UPDATE).
    await expect(
      owner.query(
        `update public.integration_webhook_deliveries set event_key = 'deal.lost' where id = $1::uuid`,
        [deliveryA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const after = (
      await owner.query<{ event_key: string }>(
        `select event_key from public.integration_webhook_deliveries where id = $1::uuid`,
        [deliveryA],
      )
    ).rows[0]!;
    expect(after.event_key).toBe('deal.won');
  }, 60_000);

  /* ── The 0058/0059 definer reads ─────────────────────────────────────── */

  it('definer: resolve_endpoint answers only the exact endpoint-key hash', async () => {
    const byHash = async (hash: string) =>
      (
        await inCtx<{ connection_id: string; org_id: string }>(
          resolvedCtxA(),
          `select connection_id, org_id from public.integration_inbound_resolve_endpoint($1)`,
          [hash],
        )
      ).rows;
    expect(await byHash(KEYHASH_A)).toEqual([{ connection_id: connA, org_id: orgA }]);
    expect(await byHash(KEYHASH_B)).toEqual([{ connection_id: connB, org_id: orgB }]);
    expect(await byHash('e5'.repeat(32))).toEqual([]);
    expect(await byHash('not-a-hash')).toEqual([]);
  }, 60_000);

  it('definer: find_receipt matches only within the named connection — external id first, payload window second', async () => {
    const find = async (
      connectionId: string,
      externalEventId: string | null,
      payloadHash: string,
    ) =>
      (
        await inCtx<{ receipt_id: string; receipt_status: string; match_kind: string }>(
          resolvedCtxA(),
          `select receipt_id, receipt_status, match_kind
           from public.integration_inbound_find_receipt($1::uuid, $2, $3)`,
          [connectionId, externalEventId, payloadHash],
        )
      ).rows;
    expect(await find(connA, `rls-evt-a-${RUN}`, 'whatever')).toEqual([
      { receipt_id: inboundA, receipt_status: 'PROCESSED', match_kind: 'external' },
    ]);
    // Org B's event id is not findable through org A's connection.
    expect(await find(connA, `rls-evt-b-${RUN}`, 'whatever')).toEqual([]);
    expect(await find(connB, `rls-evt-a-${RUN}`, 'whatever')).toEqual([]);
    // Payload-hash window match, same connection only.
    expect(await find(connA, null, PAYHASH_A)).toEqual([
      { receipt_id: inboundA, receipt_status: 'PROCESSED', match_kind: 'payload' },
    ]);
    expect(await find(connA, null, PAYHASH_B)).toEqual([]);
    expect(await find(connA, `rls-unknown-${RUN}`, 'f6'.repeat(32))).toEqual([]);
  }, 60_000);

  it('definer: resolve_delivery answers only the exact (org, subscription) pair', async () => {
    const resolve = async (orgId: string, subscriptionId: string) =>
      (
        await inCtx<{ is_active: boolean; signing_secret_ciphertext: string | null }>(
          aliceCtx(),
          `select is_active, signing_secret_ciphertext
           from public.integration_webhook_resolve_delivery($1::uuid, $2::uuid)`,
          [orgId, subscriptionId],
        )
      ).rows;
    expect(await resolve(orgA, subA)).toEqual([
      { is_active: true, signing_secret_ciphertext: `ciphertext-a-${RUN}` },
    ]);
    expect(await resolve(orgB, subA)).toEqual([]);
    expect(await resolve(orgA, subB)).toEqual([]);
    expect(await resolve(orgA, '11111111-2222-4333-8444-555555555555')).toEqual([]);
  }, 60_000);

  /* ── The W-in write shape ────────────────────────────────────────────── */

  it('inbound writes: the definer write plane admits the resolved-org context — and nothing beyond it', async () => {
    const ctx = resolvedCtxA();
    // Receipt rows are verified through the owner pool: the nil-person
    // context itself can never read them back (asserted at the end).
    const receiptRow = async (id: string) =>
      (
        await owner.query<{
          org_id: string;
          connection_id: string;
          provider_key: string;
          status: string;
          processed_at: Date | string | null;
        }>(
          `select org_id, connection_id, provider_key, status, processed_at
           from public.integration_inbound_events where id = $1::uuid`,
          [id],
        )
      ).rows[0];
    const ownerReceiptCountByExternalId = async (externalEventId: string) =>
      (
        await owner.query<{ n: number }>(
          `select count(*)::int n from public.integration_inbound_events where external_event_id = $1`,
          [externalEventId],
        )
      ).rows[0]!.n;

    // The write definer (0060): the caller names only the connection and
    // presents the endpoint digest — there is no org parameter to
    // supply. With the digest the connection actually holds, the insert
    // lands and its id comes back.
    const written = await inCtx<{ id: string }>(
      ctx,
      `select public.integration_inbound_write_receipt($1::uuid, $2, $3, $4, $5, $6) as id`,
      [connA, KEYHASH_A, `rls-definer-${RUN}`, PAYHASH_A, 'RECEIVED', false],
    );
    expect(written.rows).toHaveLength(1);
    const receiptId = written.rows[0]!.id;
    // org_id and provider_key were derived from the connection row,
    // never supplied: the receipt belongs to org A / 'webhooks', and a
    // RECEIVED receipt is not yet stamped processed.
    const fresh = await receiptRow(receiptId);
    expect(fresh).toMatchObject({
      org_id: orgA,
      connection_id: connA,
      provider_key: 'webhooks',
      status: 'RECEIVED',
    });
    expect(fresh?.processed_at).toBeNull();

    // The transition definer moves it to PROCESSED and stamps
    // processed_at — and the row's org is still org A afterwards: the
    // definer derives the org from the receipt row itself, so no call
    // can steer a receipt into another tenant.
    const transitioned = await inCtx<{ ok: boolean }>(
      ctx,
      `select public.integration_inbound_set_receipt_status($1::uuid, $2, $3) as ok`,
      [receiptId, 'PROCESSED', true],
    );
    expect(transitioned.rows[0]!.ok).toBe(true);
    const settled = await receiptRow(receiptId);
    expect(settled).toMatchObject({ org_id: orgA, status: 'PROCESSED' });
    expect(settled?.processed_at).not.toBeNull();
    // A missing receipt is a plain false, not an error (the service's
    // transitions are fire-and-forget by design).
    const missing = await inCtx<{ ok: boolean }>(
      ctx,
      `select public.integration_inbound_set_receipt_status($1::uuid, $2, $3) as ok`,
      ['11111111-2222-4333-8444-555555555555', 'PROCESSED', true],
    );
    expect(missing.rows[0]!.ok).toBe(false);

    // A wrong digest is refused 42501 inside the definer and writes no
    // row — org B's digest does not open org A's connection…
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `select public.integration_inbound_write_receipt($1::uuid, $2, $3, $4, $5, $6) as id`,
          [connA, KEYHASH_B, `rls-definer-wrong-${RUN}`, PAYHASH_A, 'RECEIVED', false],
        ),
      ),
    ).toBe('42501');
    expect(await ownerReceiptCountByExternalId(`rls-definer-wrong-${RUN}`)).toBe(0);
    // …and org A's digest does not open org B's connection either: the
    // digest is verified against the NAMED connection's stored digest,
    // so the write plane cannot be steered across tenants.
    expect(
      await sqlstateOf(
        inCtx(
          ctx,
          `select public.integration_inbound_write_receipt($1::uuid, $2, $3, $4, $5, $6) as id`,
          [connB, KEYHASH_A, `rls-definer-xorg-${RUN}`, PAYHASH_B, 'RECEIVED', false],
        ),
      ),
    ).toBe('42501');
    expect(await ownerReceiptCountByExternalId(`rls-definer-xorg-${RUN}`)).toBe(0);

    // Read-back under the same nil context still returns nothing
    // (SELECT is integrations.view-gated on a person; the nil person
    // holds nothing).
    expect(await countAs(ctx, 'integration_inbound_events', receiptId)).toBe(0);
  }, 60_000);

  it('fan-out writes: deliveries insert under a grant-less tenant context (the event raiser precedent)', async () => {
    // A second job for org A, then the link row written by a person who
    // holds NO integrations permission — the fan-out runs under whoever
    // raised the domain event (§4.5 / 0056 deliveries policy comment).
    const jobA2 = (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, payload, dedup_key)
         values ($1::uuid, 'webhook', '{}'::jsonb, $2) returning id`,
        [orgA, `rls10-job-a2-${RUN}`],
      )
    ).rows[0]!.id;
    const inserted = await inCtx(
      noGrantCtx(),
      `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
       values ($1::uuid, $2::uuid, $3::uuid, 'deal.lost')`,
      [orgA, subA, jobA2],
    );
    expect(inserted.rowCount).toBe(1);
  }, 60_000);
});
