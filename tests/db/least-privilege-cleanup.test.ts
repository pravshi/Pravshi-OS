/**
 * Migration 0082 (found by the V1 acceptance review): the privileges it removes stay removed,
 * and the ones it must not touch stay. The behaviour behind them is tested where it lives:
 * the link-immutability trigger still refusing for app_user (crm-relationships.test.ts), and
 * app_user's DELETE on deliveries, inbound events and checkpoints refused with 42501
 * (integrations-rls.test.ts).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY } from '../workflows/helpers';

describe.skipIf(!DB_READY)('least-privilege cleanup (0082, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

  afterAll(async () => {
    await owner.end();
  });

  it('no role executes the link-immutability trigger functions through PUBLIC', async () => {
    const res = await owner.query<{ fn: string; public_execute: boolean; app_user: boolean }>(
      `select p.oid::regprocedure::text fn,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_execute,
              has_function_privilege('app_user', p.oid, 'EXECUTE') app_user
       from pg_proc p
       where p.oid in ('public.enforce_activity_link_immutable()'::regprocedure,
                       'public.enforce_relationship_link_immutable()'::regprocedure)
       order by 1`,
    );
    expect(res.rows).toEqual([
      { fn: 'enforce_activity_link_immutable()', public_execute: false, app_user: false },
      { fn: 'enforce_relationship_link_immutable()', public_execute: false, app_user: false },
    ]);
  });

  it('app_user may DELETE only the integration rows a flow hard-deletes', async () => {
    const res = await owner.query<{ t: string; del: boolean }>(
      `select t, has_table_privilege('app_user', 'public.' || t, 'DELETE') del
       from unnest(array['integration_connections', 'integration_webhook_subscriptions',
                         'integration_webhook_deliveries', 'integration_inbound_events',
                         'integration_sync_checkpoints']) t
       order by t`,
    );
    expect(Object.fromEntries(res.rows.map((r) => [r.t, r.del]))).toEqual({
      integration_connections: true,
      integration_webhook_subscriptions: true,
      integration_webhook_deliveries: false,
      integration_inbound_events: false,
      integration_sync_checkpoints: false,
    });
  });
});
