/**
 * WP-T2 — the inbound pipeline when the endpoint key is rotated MID-REQUEST,
 * and the uniform answer for an organization that is not ACTIVE. LIVE DB.
 *
 * Since 0068 every receipt status change proves the endpoint key against the
 * receipt's connection (integration_inbound_set_receipt_status). A request that
 * resolved and wrote its receipt under key K1 can therefore lose the race with
 * an administrator rotating the connection to K2: its next status change is
 * refused. This suite pins what happens then, deterministically — the workflow
 * dispatch is mocked so the rotation lands exactly between "receipt written" and
 * "receipt marked PROCESSED":
 *
 *  - the request fails closed: receiveInbound throws the 42501 refusal (the
 *    route answers its opaque 500 — asserted through the route as well), and
 *    the receipt is left RECEIVED; no status change is accepted under a key the
 *    connection no longer holds;
 *  - a redelivery under the OLD key is the uniform rejection (the key resolves
 *    to nothing);
 *  - a redelivery under the NEW key with the same external event id reprocesses
 *    that same receipt to PROCESSED, with the same workflow dedup key, so the
 *    engine's (workflow, dedupKey) constraint keeps it exactly-once.
 *
 * Gated behind DB_READY; runs in CI against the ephemeral Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { DB_READY, mkOrg, mkPerson, RUN } from '../workflows/helpers';

const hoisted = vi.hoisted(() => ({
  dispatchedDedupKeys: [] as string[],
  onDispatch: null as null | (() => Promise<void>),
}));

// The workflow dispatch is the only seam between "receipt written" and
// "receipt marked PROCESSED"; it records its dedup key and runs the hook.
vi.mock('@/lib/workflows/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workflows/events')>();
  return {
    ...actual,
    dispatchWorkflowEvent: vi.fn(async (_auth: unknown, event: { dedupKey: string }) => {
      hoisted.dispatchedDedupKeys.push(event.dedupKey);
      const hook = hoisted.onDispatch;
      hoisted.onDispatch = null;
      if (hook) await hook();
    }),
  };
});

import {
  generateEndpointKey,
  hashEndpointKey,
  receiveInbound,
  rejectionResult,
} from '@/lib/integrations/inbound';
import { POST } from '@/app/api/integrations/inbound/[endpointKey]/route';

const codeOf = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
};

describe.skipIf(!DB_READY)('inbound endpoint key rotated mid-request (0068, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';
  let connectionId = '';

  const setKey = (key: string) =>
    owner.query(
      `update public.integration_connections set inbound_endpoint_key_hash = $2 where id = $1`,
      [connectionId, hashEndpointKey(key)],
    );
  const receiptsFor = async (eventId: string) =>
    (
      await owner.query<{ id: string; status: string; org_id: string }>(
        `select id, status, org_id from public.integration_inbound_events
          where connection_id = $1 and external_event_id = $2`,
        [connectionId, eventId],
      )
    ).rows;
  const post = (key: string, eventId: string, body: string) =>
    POST(
      new Request(`http://localhost:3000/api/integrations/inbound/${key}`, {
        method: 'POST',
        headers: { 'x-event-id': eventId },
        body,
      }),
      { params: Promise.resolve({ endpointKey: key }) },
    );

  beforeAll(async () => {
    if (!DB_READY) return;
    orgId = await mkOrg(owner, `inrot-${RUN}`);
    const connectedBy = await mkPerson(owner, orgId, `Inrot Owner ${RUN}`);
    connectionId = (
      await owner.query<{ id: string }>(
        `insert into public.integration_connections
           (org_id, provider_key, display_name, status, config, connected_by)
         values ($1, 'webhooks', $2, 'CONNECTED', '{}'::jsonb, $3) returning id`,
        [orgId, `Inrot ${RUN}`, connectedBy],
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('fails closed: the refusal surfaces, the receipt stays RECEIVED, and a new-key redelivery recovers it exactly once', async () => {
    const k1 = generateEndpointKey();
    const k2 = generateEndpointKey();
    await setKey(k1);
    const eventId = `evt-rot-${randomUUID()}`;
    const body = JSON.stringify({ rotated: 'mid-request' });
    hoisted.dispatchedDedupKeys.length = 0;

    // An administrator rotates the key while the request is dispatching.
    hoisted.onDispatch = () => setKey(k2).then(() => undefined);
    let refusal: unknown = null;
    try {
      await receiveInbound(k1, body, new Headers({ 'x-event-id': eventId }));
    } catch (error) {
      refusal = error;
    }
    expect(refusal, 'the pipeline must not report success').not.toBeNull();
    expect(codeOf(refusal)).toBe('42501');

    const afterRace = await receiptsFor(eventId);
    expect(afterRace).toHaveLength(1);
    expect(afterRace[0]).toMatchObject({ status: 'RECEIVED', org_id: orgId });
    expect(hoisted.dispatchedDedupKeys).toEqual([`integration_inbound_event:${afterRace[0]!.id}`]);

    // The old key no longer resolves: the uniform rejection, nothing written.
    expect(await receiveInbound(k1, body, new Headers({ 'x-event-id': eventId }))).toEqual(
      rejectionResult(),
    );
    expect(await receiptsFor(eventId)).toHaveLength(1);

    // The sender redelivers under the new key: the SAME receipt is reprocessed
    // to PROCESSED, dispatching with the same dedup key (exactly-once downstream).
    expect(await receiveInbound(k2, body, new Headers({ 'x-event-id': eventId }))).toEqual({
      httpStatus: 200,
      body: { status: 'accepted' },
    });
    const recovered = await receiptsFor(eventId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: afterRace[0]!.id, status: 'PROCESSED' });
    expect(hoisted.dispatchedDedupKeys).toEqual([
      `integration_inbound_event:${afterRace[0]!.id}`,
      `integration_inbound_event:${afterRace[0]!.id}`,
    ]);
  }, 60_000);

  it('the route answers the race with its opaque 500 — no detail, no key', async () => {
    const k1 = generateEndpointKey();
    const k2 = generateEndpointKey();
    await setKey(k1);
    const eventId = `evt-rot-route-${randomUUID()}`;
    hoisted.onDispatch = () => setKey(k2).then(() => undefined);

    const res = await post(k1, eventId, JSON.stringify({ via: 'route' }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL', message: 'Internal error.' } });
    expect(text).not.toContain(k1);
    expect(text).not.toContain(orgId);
    expect((await receiptsFor(eventId))[0]?.status).toBe('RECEIVED');
  }, 60_000);

  it('an organization that is not ACTIVE answers exactly like an unknown key, writes nothing, and recovers on reactivation', async () => {
    const key = generateEndpointKey();
    await setKey(key);
    const unknown = await receiveInbound(generateEndpointKey(), '{}', new Headers());

    for (const [label, deactivate] of [
      ['SUSPENDED', `update public.organizations set status = 'SUSPENDED' where id = $1`],
      ['ARCHIVED', `update public.organizations set status = 'ARCHIVED' where id = $1`],
      ['deleted', `update public.organizations set deleted_at = now() where id = $1`],
    ] as const) {
      const eventId = `evt-inactive-${label}-${randomUUID()}`;
      // A distinct body per state: an identical body would (correctly) hit the
      // 24-hour payload-dedup window on the next iteration and record DUPLICATE.
      const body = JSON.stringify({ inactive: label, n: randomUUID() });
      await owner.query(deactivate, [orgId]);
      try {
        const refused = await receiveInbound(key, body, new Headers({ 'x-event-id': eventId }));
        expect(refused, label).toEqual(unknown);
        expect(refused, label).toEqual(rejectionResult());
        expect(await receiptsFor(eventId), label).toHaveLength(0);
      } finally {
        await owner.query(
          `update public.organizations set status = 'ACTIVE', deleted_at = null where id = $1`,
          [orgId],
        );
      }
      expect(
        await receiveInbound(key, body, new Headers({ 'x-event-id': eventId })),
        label,
      ).toEqual({ httpStatus: 200, body: { status: 'accepted' } });
      expect((await receiptsFor(eventId))[0]?.status, label).toBe('PROCESSED');
    }
  }, 90_000);
});
