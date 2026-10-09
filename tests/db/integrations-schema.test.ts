import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 10 (migrations 0056/0057) — the integrations schema, structurally.
 *
 * The questions this file exists to answer:
 *   - do all five contract §4.1 tables exist with RLS enabled AND forced
 *     (the census in six other files counts their app_user policies at 105;
 *     this file pins the tables themselves);
 *   - are the column sets exactly the contract's — in particular, does
 *     integration_connections carry NO credential-shaped column beyond the
 *     four sanctioned §4.3 columns (credential_ciphertext / _nonce /
 *     _key_version / credential_ref), and does no table store a raw secret,
 *     a raw inbound body, or record content;
 *   - does the inbound idempotency partial UNIQUE exist, with its predicate;
 *   - is every table's identity frozen on UPDATE (the enforce_*_integrity
 *     trigger pattern) behind an app_user UPDATE policy, and are the
 *     append-only deliveries rows policyless for update/delete;
 *   - do the journal entries for 0056/0057 respect the Phase 8 collision
 *     lesson (when strictly greater than 0055's, strictly increasing).
 *
 * Behavioural RLS isolation lives in tests/db/integrations-rls.test.ts
 * (Wave J); this file is the schema's shape only, read as the owner.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const TABLES = [
  'integration_connections',
  'integration_inbound_events',
  'integration_sync_checkpoints',
  'integration_webhook_deliveries',
  'integration_webhook_subscriptions',
] as const;

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

const columnsOf = async (table: string) =>
  (
    await owner.query<{ cols: string }>(
      `select string_agg(column_name, ',' order by column_name) cols
       from information_schema.columns
       where table_schema='public' and table_name=$1`,
      [table],
    )
  ).rows[0]!.cols;

describe('structure', () => {
  it('creates all five tables with RLS enabled and forced', async () => {
    const { rows } = await owner.query<{ relname: string; e: boolean; f: boolean }>(
      `select relname, relrowsecurity e, relforcerowsecurity f from pg_class
       where relname in ('integration_connections','integration_inbound_events',
                         'integration_sync_checkpoints','integration_webhook_deliveries',
                         'integration_webhook_subscriptions')
       order by relname`,
    );
    expect(rows).toEqual(TABLES.map((relname) => ({ relname, e: true, f: true })));
  });

  it('gives integration_connections exactly the §4.1 columns — credentials only as vault parts or an env ref', async () => {
    expect(await columnsOf('integration_connections')).toBe(
      'config,connected_by,created_at,credential_ciphertext,credential_key_version,' +
        'credential_nonce,credential_ref,display_name,id,inbound_endpoint_key_hash,' +
        'last_error_code,last_health_at,org_id,provider_key,status,updated_at',
    );
    // §4.3, asserted by name: beyond the four sanctioned credential columns,
    // nothing that could hold a raw secret, a token, or content may exist.
    const offenders = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='integration_connections'
         and column_name in ('secret','password','api_key','access_token','refresh_token',
                             'prompt','response','content','messages')
       order by column_name`,
    );
    expect(offenders.rows).toEqual([]);
    // And the sanctioned set is exactly the §4.3 set — no fifth hiding place.
    const credentialCols = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='integration_connections'
         and (column_name like 'credential%' or column_name like '%secret%')
       order by column_name`,
    );
    expect(credentialCols.rows.map((r) => r.column_name)).toEqual([
      'credential_ciphertext',
      'credential_key_version',
      'credential_nonce',
      'credential_ref',
    ]);
  });

  it('gives the remaining four tables exactly the §4.1 columns', async () => {
    expect(await columnsOf('integration_webhook_subscriptions')).toBe(
      'active,created_at,created_by,events,id,org_id,signing_secret_ciphertext,' +
        'signing_secret_key_version,signing_secret_nonce,updated_at,url',
    );
    expect(await columnsOf('integration_webhook_deliveries')).toBe(
      'created_at,event_key,id,job_id,org_id,subscription_id',
    );
    expect(await columnsOf('integration_inbound_events')).toBe(
      'connection_id,endpoint_key,external_event_id,id,org_id,payload_hash,' +
        'processed_at,provider_key,received_at,status',
    );
    expect(await columnsOf('integration_sync_checkpoints')).toBe(
      'connection_id,created_at,cursor,id,last_synced_at,org_id,resource,status,updated_at',
    );
    // The subscription signing secret exists only as ciphertext parts —
    // never a plaintext `signing_secret` (or any bare secret) column.
    const plaintext = await owner.query(
      `select 1 from information_schema.columns
       where table_schema='public' and table_name='integration_webhook_subscriptions'
         and column_name in ('signing_secret','secret','password','api_key')`,
    );
    expect(plaintext.rows).toEqual([]);
    // Inbound events store hashes only: no payload/body column, ever.
    const body = await owner.query(
      `select 1 from information_schema.columns
       where table_schema='public' and table_name='integration_inbound_events'
         and column_name in ('payload','body','raw_body','content')`,
    );
    expect(body.rows).toEqual([]);
  });

  it('enforces the §4.1 status vocabularies and the checkpoint uniqueness', async () => {
    const { rows } = await owner.query<{ conname: string }>(
      `select conname from pg_constraint
       where conname in ('integration_connections_status_check',
                         'integration_inbound_events_status_check',
                         'integration_sync_checkpoints_connection_resource_unique')
       order by conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'integration_connections_status_check',
      'integration_inbound_events_status_check',
      'integration_sync_checkpoints_connection_resource_unique',
    ]);
  });

  it('creates the inbound idempotency partial UNIQUE with its predicate intact', async () => {
    const { rows } = await owner.query<{ indexdef: string; indisunique: boolean }>(
      `select pg_get_indexdef(i.indexrelid) indexdef, i.indisunique
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       where c.relname = 'integration_inbound_events_connection_external_unique'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indisunique).toBe(true);
    expect(rows[0]!.indexdef).toContain('(connection_id, external_event_id)');
    expect(rows[0]!.indexdef).toMatch(/WHERE \(external_event_id IS NOT NULL\)/);
  });

  it('points the foreign keys at the contract parents', async () => {
    const { rows } = await owner.query<{ tbl: string; ref: string }>(
      `select cl.relname tbl, cr.relname ref
       from pg_constraint k
       join pg_class cl on cl.oid = k.conrelid
       join pg_class cr on cr.oid = k.confrelid
       where k.contype = 'f'
         and cl.relname in ('integration_connections','integration_inbound_events',
                            'integration_sync_checkpoints','integration_webhook_deliveries',
                            'integration_webhook_subscriptions')
       order by tbl, ref`,
    );
    const pairs = rows.map((r) => `${r.tbl}->${r.ref}`);
    expect(pairs).toContain('integration_connections->organizations');
    expect(pairs).toContain('integration_connections->people');
    expect(pairs).toContain('integration_webhook_subscriptions->organizations');
    expect(pairs).toContain('integration_webhook_subscriptions->people');
    expect(pairs).toContain('integration_webhook_deliveries->integration_webhook_subscriptions');
    expect(pairs).toContain('integration_webhook_deliveries->jobs');
    expect(pairs).toContain('integration_inbound_events->integration_connections');
    expect(pairs).toContain('integration_sync_checkpoints->integration_connections');
  });

  it('freezes identity columns on UPDATE behind the integrity triggers', async () => {
    const { rows } = await owner.query<{ tgname: string }>(
      `select tgname from pg_trigger
       where tgname in ('integration_connections_identity_freeze',
                        'integration_webhook_subscriptions_identity_freeze',
                        'integration_webhook_deliveries_identity_freeze',
                        'integration_inbound_events_identity_freeze',
                        'integration_sync_checkpoints_identity_freeze')
       order by tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'integration_connections_identity_freeze',
      'integration_inbound_events_identity_freeze',
      'integration_sync_checkpoints_identity_freeze',
      'integration_webhook_deliveries_identity_freeze',
      'integration_webhook_subscriptions_identity_freeze',
    ]);
    // The tenant guards ride alongside (org validity + parent-org agreement).
    const guards = await owner.query<{ tgname: string }>(
      `select tgname from pg_trigger
       where tgname like 'integration%org_guard' order by tgname`,
    );
    expect(guards.rows.map((r) => r.tgname)).toEqual([
      'integration_connections_org_guard',
      'integration_connections_person_org_guard',
      'integration_inbound_events_org_guard',
      'integration_inbound_events_parent_org_guard',
      'integration_sync_checkpoints_org_guard',
      'integration_sync_checkpoints_parent_org_guard',
      'integration_webhook_deliveries_org_guard',
      'integration_webhook_deliveries_parent_org_guard',
      'integration_webhook_subscriptions_org_guard',
      'integration_webhook_subscriptions_person_org_guard',
    ]);
  });

  it('gates app_user writes with policies — and leaves deliveries append-only', async () => {
    const { rows } = await owner.query<{ tablename: string; cmd: string }>(
      `select tablename, cmd from pg_policies
       where schemaname='public' and 'app_user' = any(roles)
         and tablename like 'integration%'
       order by tablename, cmd`,
    );
    const pairs = rows.map((r) => `${r.tablename}:${r.cmd}`);
    // The four mutable tables carry UPDATE policies (behind which the
    // freeze triggers bound what may change)…
    for (const t of [
      'integration_connections',
      'integration_webhook_subscriptions',
      'integration_inbound_events',
      'integration_sync_checkpoints',
    ]) {
      expect(pairs, t).toContain(`${t}:UPDATE`);
      expect(pairs, t).toContain(`${t}:SELECT`);
      expect(pairs, t).toContain(`${t}:INSERT`);
    }
    // …connections/subscriptions are hard-deletable by managers (§4.4)…
    expect(pairs).toContain('integration_connections:DELETE');
    expect(pairs).toContain('integration_webhook_subscriptions:DELETE');
    // …and deliveries are append-only from the runtime role.
    expect(pairs).toContain('integration_webhook_deliveries:SELECT');
    expect(pairs).toContain('integration_webhook_deliveries:INSERT');
    expect(pairs).not.toContain('integration_webhook_deliveries:UPDATE');
    expect(pairs).not.toContain('integration_webhook_deliveries:DELETE');
    // Sixteen app_user policies in all — the delta six census files pin.
    expect(rows).toHaveLength(16);
  });

  it('keeps 0056/0057 journal timestamps strictly above 0055 and increasing (Phase 8 lesson)', () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const e55 = journal.entries.find((e) => e.tag === '0055_ai_permissions')!;
    const e56 = journal.entries.find((e) => e.tag === '0056_integrations_schema')!;
    const e57 = journal.entries.find((e) => e.tag === '0057_integrations_permissions')!;
    expect(e55.when).toBe(1791343891090);
    expect(e56.when).toBe(1791343891091);
    expect(e57.when).toBe(1791343891092);
    expect(e56.when).toBeGreaterThan(e55.when);
    expect(e57.when).toBeGreaterThan(e56.when);
    expect(e56.idx).toBe(e55.idx + 1);
    expect(e57.idx).toBe(e56.idx + 1);
  });
});
