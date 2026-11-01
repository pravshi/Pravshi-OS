import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertCanCreateConnection } from './config';
import { assertIntegrationUuid, fromVaultError, IntegrationsError } from './errors';
import { getProviderDefinition, type IntegrationProviderDefinition } from './providers';
import {
  decryptSecret,
  encryptSecret,
  maskIdentifier,
  serialiseEnvelope,
  type VaultEnvelope,
} from './secrets';

/**
 * Connections service — Phase 10 contract §4.1 (table 1), §4.3 (credential
 * tiers), §4.4 (the routes these functions back). Modelled on the CRM
 * services (src/lib/crm/companies.ts) and the Phase 9 AI services.
 *
 * Trust boundaries, restated from the contract:
 *  - org_id ALWAYS comes from auth.ctx.orgId, never from caller input; every
 *    query additionally predicates on it (defence in depth on top of RLS).
 *  - provider_key must exist in the CODE registry (providers/); the DB has
 *    no FK for it by design (§4.1 decision).
 *  - config is NON-SECRET only: it is scanned for credential-shaped keys
 *    (deep, case-insensitive) BEFORE the provider's zod schema parses it,
 *    and the parsed result is scanned again — a secret cannot be smuggled
 *    into config under a name a schema happens to accept.
 *  - Identity columns (id, org_id, provider_key, connected_by, created_at)
 *    are frozen by the 0056 BEFORE UPDATE trigger; the service guards them
 *    too (assertNoIdentityFields) so an attempt fails as VALIDATION here
 *    rather than as an opaque 23514 from the database.
 *  - Id arguments are validated against the module's shared uuid schema
 *    (errors.ts assertIntegrationUuid) BEFORE any SQL runs, so a
 *    malformed id fails as the typed VALIDATION here rather than as
 *    Postgres 22P02 from a `${id}::uuid` cast (Wave J Finding 1, service
 *    half — the route half is http.ts parseIntegrationId).
 *  - Credential material NEVER leaves this module in a DTO: list/get
 *    return IntegrationConnectionSummary, whose shape has no ciphertext,
 *    nonce or secret field at all (§4.3). The one plaintext exit is
 *    resolveConnectionCredential, for provider calls only (Waves P/W) —
 *    never route it to a response, a log or an audit entry.
 *  - Disconnect DESTROYS the credential (ciphertext columns and ref nulled)
 *    before the row is deleted (§4.3, §4.4); a status change INTO
 *    DISCONNECTED through update applies the same destruction.
 *
 * ENVELOPE STORAGE (ambiguity in §4.3/0056, resolved with Wave K):
 * credential_ciphertext stores the vault envelope in its SERIALISED form
 * (secrets.ts `serialiseEnvelope`) — the envelope is the unit that keeps
 * the GCM tag with its ciphertext, and 0056 has no tag column. The nonce
 * and key version are ALSO written to credential_nonce /
 * credential_key_version, where 0056 put them, for auditability; decryption
 * goes through decryptSecret(serialised), which re-reads all four parts
 * from the envelope itself.
 */

export type IntegrationConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'NOT_CONFIGURED';

/** The only shape list/get ever return. No credential material, by construction. */
export interface IntegrationConnectionSummary {
  readonly id: string;
  readonly providerKey: string;
  readonly displayName: string;
  readonly status: IntegrationConnectionStatus;
  /** Non-secret configuration, exactly as validated against the provider schema. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly hasCredential: boolean;
  /** maskIdentifier() of the Tier E credential_ref (an env var NAME, never a secret); null for Tier V / none. */
  readonly maskedCredentialRef: string | null;
  readonly connectedBy: string | null;
  readonly lastHealthAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationConnectionPage {
  readonly rows: readonly IntegrationConnectionSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Credential columns are selected ONLY by the internal paths that need them. */
type ConnectionCredentialDbRow = {
  provider_key: string;
  credential_ciphertext: string | null;
  credential_ref: string | null;
};

const SELECT_COLUMNS = sql`
  c.id,
  c.provider_key as "providerKey",
  c.display_name as "displayName",
  c.status,
  c.config,
  c.credential_ciphertext as "credentialCiphertext",
  c.credential_ref as "credentialRef",
  c.connected_by as "connectedBy",
  c.last_health_at as "lastHealthAt",
  c.last_error_code as "lastErrorCode",
  c.created_at as "createdAt",
  c.updated_at as "updatedAt"
`;

const BASE_WHERE = (auth: Authorization) => sql`c.org_id = ${auth.ctx.orgId}::uuid`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Row → safe DTO. The ciphertext feeds ONLY the hasCredential boolean; the
 * ref feeds only its masked form. Nothing else about the credential columns
 * survives this function — the unit suite pins that.
 */
export function toConnectionSummary(row: {
  id: string;
  providerKey: string;
  displayName: string;
  status: IntegrationConnectionStatus;
  config: Record<string, unknown>;
  credentialCiphertext: string | null;
  credentialRef: string | null;
  connectedBy: string | null;
  lastHealthAt: Date | string | null;
  lastErrorCode: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): IntegrationConnectionSummary {
  return {
    id: row.id,
    providerKey: row.providerKey,
    displayName: row.displayName,
    status: row.status,
    config: row.config,
    hasCredential: row.credentialCiphertext !== null || row.credentialRef !== null,
    maskedCredentialRef: maskIdentifier(row.credentialRef),
    connectedBy: row.connectedBy,
    lastHealthAt: row.lastHealthAt === null ? null : toDate(row.lastHealthAt),
    lastErrorCode: row.lastErrorCode,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

/* ── Config hygiene: credential-shaped keys and provider schema ──────────── */

/**
 * Keys that mark a config entry as a credential in disguise. Mirrors the
 * vault layer's SENSITIVE_KEY (secrets.ts) and the write_audit_log backstop
 * vocabulary — the same words are radioactive everywhere in this system.
 */
const CREDENTIAL_KEY_PATTERN =
  /(secret|password|passwd|token|api[-_]?key|authorization|credential|ciphertext|nonce|private[-_]?key)/i;

/**
 * Deep-scan a config value for credential-shaped keys; returns the dotted
 * paths found (key names only — never values). Recurses through plain
 * objects and arrays.
 */
export function findCredentialKeys(value: unknown, path = 'config'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findCredentialKeys(item, `${path}.${index}`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => [
      ...(CREDENTIAL_KEY_PATTERN.test(key) ? [`${path}.${key}`] : []),
      ...findCredentialKeys(entry, `${path}.${key}`),
    ]);
  }
  return [];
}

/**
 * Validate raw config for one provider: credential-key scan → the
 * provider's strict zod schema → scan the parsed result again. Any failure
 * is an IntegrationsError VALIDATION whose detail is a field PATH only.
 */
export function validateConnectionConfig(
  provider: IntegrationProviderDefinition,
  rawConfig: unknown,
): Record<string, unknown> {
  const before = findCredentialKeys(rawConfig);
  if (before.length > 0) {
    throw new IntegrationsError('VALIDATION', before[0]);
  }
  const parsed = provider.configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `config.${first.path.join('.')}` : 'config';
    throw new IntegrationsError('VALIDATION', where);
  }
  const after = findCredentialKeys(parsed.data);
  if (after.length > 0) {
    throw new IntegrationsError('VALIDATION', after[0]);
  }
  return parsed.data;
}

/* ── Identity-column guard (service-level twin of the 0056 freeze) ───────── */

const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'orgId',
  'org_id',
  'providerKey',
  'provider_key',
  'connectedBy',
  'connected_by',
  'createdAt',
  'created_at',
]);

/** Throws VALIDATION when an update payload tries to name an identity column. */
export function assertNoIdentityFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (IDENTITY_FIELDS.has(key)) {
      throw new IntegrationsError('VALIDATION', key);
    }
  }
}

/* ── Input schemas (exported for Wave G route reuse) ─────────────────────── */

const StatusSchema = z.enum(['CONNECTED', 'DISCONNECTED', 'ERROR', 'NOT_CONFIGURED']);

export const ListConnectionsQuerySchema = z.strictObject({
  providerKey: z.string().min(1).max(64).optional(),
  status: StatusSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const CreateConnectionInputSchema = z.strictObject({
  providerKey: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Tier V only: the org-entered secret, write-only. Never echoed, never logged. */
  secret: z.string().min(1).max(8192).optional(),
  /** Tier E only: must equal the provider's fixed credentialRefEnvVar. */
  credentialRef: z.string().min(1).max(128).optional(),
});

export const UpdateConnectionInputSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(120).optional(),
    /** Shallow-merged over the stored config, then the merged result is validated whole. */
    config: z.record(z.string(), z.unknown()).optional(),
    status: StatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'no fields to update' });

export const RotateSecretInputSchema = z
  .strictObject({
    /** Tier V: the replacement secret (required — V1 holds one key version, so re-encrypting the old plaintext under the same key would change nothing). */
    secret: z.string().min(1).max(8192).optional(),
    /** Tier E: the replacement ref (must equal the provider's fixed env var). */
    credentialRef: z.string().min(1).max(128).optional(),
  })
  .refine((value) => value.secret !== undefined || value.credentialRef !== undefined, {
    message: 'a new secret or credential ref is required',
  });

export const RecordHealthInputSchema = z.strictObject({
  ok: z.boolean(),
  /** Normalised code only (§4.3): uppercase identifier characters, never a raw provider message. */
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
});

/* ── Internal row access ─────────────────────────────────────────────────── */

async function fetchSummaryRow(
  auth: Authorization,
  id: string,
): Promise<IntegrationConnectionSummary | null> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Parameters<typeof toConnectionSummary>[0]>(sql`
      select ${SELECT_COLUMNS}
      from public.integration_connections c
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    const row = res.rows[0];
    return row ? toConnectionSummary(row) : null;
  });
}

async function fetchCredentialRow(
  auth: Authorization,
  id: string,
): Promise<ConnectionCredentialDbRow | null> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<ConnectionCredentialDbRow>(sql`
      select c.provider_key, c.credential_ciphertext, c.credential_ref
      from public.integration_connections c
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
}

function requireProvider(providerKey: string): IntegrationProviderDefinition {
  const provider = getProviderDefinition(providerKey);
  if (!provider) throw new IntegrationsError('VALIDATION', 'providerKey');
  return provider;
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listConnections(
  auth: Authorization,
  input: unknown,
): Promise<IntegrationConnectionPage> {
  const query = ListConnectionsQuerySchema.parse(input ?? {});
  const providerFilter = query.providerKey
    ? sql` and c.provider_key = ${query.providerKey}`
    : sql``;
  const statusFilter = query.status ? sql` and c.status = ${query.status}` : sql``;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Parameters<typeof toConnectionSummary>[0]>(sql`
        select ${SELECT_COLUMNS}
        from public.integration_connections c
        where ${BASE_WHERE(auth)}${providerFilter}${statusFilter}
        order by c.created_at desc, c.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.integration_connections c
        where ${BASE_WHERE(auth)}${providerFilter}${statusFilter}
      `),
    ]);
    return {
      rows: rows.rows.map(toConnectionSummary),
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

/** Cross-tenant and missing ids are indistinguishable: NOT_FOUND (§4.7). */
export async function getConnection(
  auth: Authorization,
  id: string,
): Promise<IntegrationConnectionSummary> {
  assertIntegrationUuid(id, 'connectionId');
  const summary = await fetchSummaryRow(auth, id);
  await assertTargetAffected(auth, summary ? 1 : 0);
  return summary as IntegrationConnectionSummary;
}

/* ── Create ──────────────────────────────────────────────────────────────── */

export async function createConnection(
  auth: Authorization,
  input: unknown,
): Promise<IntegrationConnectionSummary> {
  const data = CreateConnectionInputSchema.parse(input);
  const provider = requireProvider(data.providerKey);
  const config = validateConnectionConfig(provider, data.config ?? provider.defaultConfig);

  // Credential channel, per tier (§4.3). The two channels are mutually
  // exclusive and each rejects the other's input as VALIDATION — a pasted
  // secret must never land on a Tier E row, nor a ref on a Tier V row.
  let credentialCiphertext: string | null = null;
  let credentialNonce: string | null = null;
  let credentialKeyVersion: number | null = null;
  let credentialRef: string | null = null;
  if (provider.credentialTier === 'vault') {
    if (data.credentialRef !== undefined) {
      throw new IntegrationsError('VALIDATION', 'credentialRef');
    }
    if (data.secret !== undefined) {
      try {
        assertCanCreateConnection('vault');
        const envelope = encryptSecret(data.secret);
        credentialCiphertext = serialiseEnvelope(envelope);
        credentialNonce = envelope.nonce;
        credentialKeyVersion = envelope.keyVersion;
      } catch (error) {
        throw fromVaultError(error);
      }
    }
  } else {
    if (data.secret !== undefined) {
      throw new IntegrationsError('VALIDATION', 'secret');
    }
    const ref = data.credentialRef ?? provider.credentialRefEnvVar;
    if (ref !== provider.credentialRefEnvVar) {
      throw new IntegrationsError('VALIDATION', 'credentialRef');
    }
    credentialRef = ref;
  }

  const hasCredential = credentialCiphertext !== null || credentialRef !== null;
  const status: IntegrationConnectionStatus = hasCredential ? 'CONNECTED' : 'NOT_CONFIGURED';

  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    if (provider.singleton) {
      const existing = await tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.integration_connections c
        where ${BASE_WHERE(auth)}
          and c.provider_key = ${provider.key}
      `);
      if ((existing.rows[0]?.total ?? 0) > 0) {
        throw new IntegrationsError('CONFLICT', 'providerKey');
      }
    }
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.integration_connections (
        org_id, provider_key, display_name, status, config,
        credential_ciphertext, credential_nonce, credential_key_version, credential_ref,
        connected_by
      ) values (
        ${auth.ctx.orgId}::uuid, ${provider.key}, ${data.displayName}, ${status},
        ${JSON.stringify(config)}::jsonb,
        ${credentialCiphertext}, ${credentialNonce}, ${credentialKeyVersion}, ${credentialRef},
        ${auth.ctx.personId}::uuid
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Integration connection creation failed.');
    return row.id;
  });

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.connection.created',
      entityType: 'integration_connection',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {
        providerKey: provider.key,
        credentialTier: provider.credentialTier,
        hasCredential,
        status,
      },
    },
    auth.meta,
  );
  return getConnection(auth, id);
}

/* ── Update (config / display name / status) ─────────────────────────────── */

export async function updateConnection(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<IntegrationConnectionSummary> {
  assertIntegrationUuid(id, 'connectionId');
  if (typeof input === 'object' && input !== null) {
    assertNoIdentityFields(input as Record<string, unknown>);
  }
  const data = UpdateConnectionInputSchema.parse(input);
  const current = await fetchSummaryRow(auth, id);
  await assertTargetAffected(auth, current ? 1 : 0);
  const existing = current as IntegrationConnectionSummary;
  const provider = requireProvider(existing.providerKey);

  const sets: SQL[] = [];
  const changedFields: string[] = [];
  if (data.displayName !== undefined) {
    sets.push(sql`display_name = ${data.displayName}`);
    changedFields.push('displayName');
  }
  if (data.config !== undefined) {
    const merged = { ...existing.config, ...data.config };
    const validated = validateConnectionConfig(provider, merged);
    sets.push(sql`config = ${JSON.stringify(validated)}::jsonb`);
    changedFields.push('config');
  }
  if (data.status !== undefined) {
    sets.push(sql`status = ${data.status}`);
    changedFields.push('status');
    if (data.status === 'DISCONNECTED') {
      // §4.3: disconnecting destroys the credential, whichever surface asks.
      sets.push(sql`
        credential_ciphertext = null,
        credential_nonce = null,
        credential_key_version = null,
        credential_ref = null
      `);
      changedFields.push('credentialDestroyed');
    }
  }

  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.integration_connections c
      set ${sql.join(sets, sql`, `)}
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
      returning c.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.connection.updated',
      entityType: 'integration_connection',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { providerKey: provider.key, fields: changedFields.join(',') },
    },
    auth.meta,
  );
  return getConnection(auth, id);
}

/* ── Disconnect (DELETE): destroy the credential, then delete the row ───── */

export async function disconnectConnection(auth: Authorization, id: string): Promise<void> {
  assertIntegrationUuid(id, 'connectionId');
  const providerKey = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ provider_key: string }>(sql`
      select c.provider_key
      from public.integration_connections c
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    const row = res.rows[0];
    if (!row) return null;
    // §4.3/§4.4 order: the credential is destroyed first, the row second —
    // a failure between the two leaves a credential-less row, never a
    // deleted row whose secret outlived it somewhere.
    await tx.execute(sql`
      update public.integration_connections c
      set credential_ciphertext = null,
          credential_nonce = null,
          credential_key_version = null,
          credential_ref = null,
          status = 'DISCONNECTED'
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    await tx.execute(sql`
      delete from public.integration_connections c
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
    `);
    return row.provider_key;
  });
  await assertTargetAffected(auth, providerKey ? 1 : 0);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.connection.disconnected',
      entityType: 'integration_connection',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: { providerKey: providerKey as string, credentialDestroyed: true },
    },
    auth.meta,
  );
}

/* ── Secret rotation ─────────────────────────────────────────────────────── */

export async function rotateConnectionSecret(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<IntegrationConnectionSummary> {
  assertIntegrationUuid(id, 'connectionId');
  const data = RotateSecretInputSchema.parse(input);
  const credentialRow = await fetchCredentialRow(auth, id);
  await assertTargetAffected(auth, credentialRow ? 1 : 0);
  const existing = credentialRow as ConnectionCredentialDbRow;
  const provider = requireProvider(existing.provider_key);

  if (provider.credentialTier === 'vault') {
    if (data.credentialRef !== undefined) {
      throw new IntegrationsError('VALIDATION', 'credentialRef');
    }
    if (data.secret === undefined) {
      throw new IntegrationsError('VALIDATION', 'secret');
    }
    let envelope: VaultEnvelope;
    try {
      assertCanCreateConnection('vault');
      envelope = encryptSecret(data.secret);
    } catch (error) {
      throw fromVaultError(error);
    }
    const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute(sql`
        update public.integration_connections c
        set credential_ciphertext = ${serialiseEnvelope(envelope)},
            credential_nonce = ${envelope.nonce},
            credential_key_version = ${envelope.keyVersion}
        where ${BASE_WHERE(auth)}
          and c.id = ${id}::uuid
        returning c.id
      `);
      return res.rowCount ?? 0;
    });
    await assertTargetAffected(auth, affected);
  } else {
    if (data.secret !== undefined) {
      throw new IntegrationsError('VALIDATION', 'secret');
    }
    const ref = data.credentialRef ?? provider.credentialRefEnvVar;
    if (ref !== provider.credentialRefEnvVar) {
      throw new IntegrationsError('VALIDATION', 'credentialRef');
    }
    const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute(sql`
        update public.integration_connections c
        set credential_ref = ${ref}
        where ${BASE_WHERE(auth)}
          and c.id = ${id}::uuid
        returning c.id
      `);
      return res.rowCount ?? 0;
    });
    await assertTargetAffected(auth, affected);
  }

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.connection.secret_rotated',
      entityType: 'integration_connection',
      entityId: id,
      result: 'SUCCESS',
      severity: 'HIGH',
      metadata: { providerKey: provider.key, credentialTier: provider.credentialTier },
    },
    auth.meta,
  );
  return getConnection(auth, id);
}

/* ── Health recorder ─────────────────────────────────────────────────────── */

/**
 * Records one health outcome on the row: last_health_at always advances;
 * last_error_code stores the NORMALISED code (null on success); status
 * moves only between CONNECTED and ERROR — a health signal never
 * resurrects a DISCONNECTED connection or completes a NOT_CONFIGURED one.
 * Deliberately NOT audit-logged per call: this is a high-frequency machine
 * signal, and the row itself is its record.
 */
export async function recordConnectionHealth(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<IntegrationConnectionSummary> {
  assertIntegrationUuid(id, 'connectionId');
  const data = RecordHealthInputSchema.parse(input);
  const current = await fetchSummaryRow(auth, id);
  await assertTargetAffected(auth, current ? 1 : 0);
  const existing = current as IntegrationConnectionSummary;

  let status = existing.status;
  if (data.ok && existing.status === 'ERROR') status = 'CONNECTED';
  if (!data.ok && existing.status === 'CONNECTED') status = 'ERROR';
  const errorCode = data.ok ? null : (data.errorCode ?? 'PROVIDER_ERROR');

  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.integration_connections c
      set last_health_at = now(),
          last_error_code = ${errorCode},
          status = ${status}
      where ${BASE_WHERE(auth)}
        and c.id = ${id}::uuid
      returning c.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  return getConnection(auth, id);
}

/* ── Credential resolution (INTERNAL — Waves P/W provider calls only) ────── */

/**
 * The module's one plaintext exit. Tier V: decrypts the stored envelope
 * (vault failures mapped into the taxonomy — VAULT_NOT_CONFIGURED becomes
 * NOT_CONFIGURED, a tampered/wrong-key envelope CREDENTIAL_UNREADABLE).
 * Tier E: returns null — the credential lives in the deployment env and the
 * adapter reads it there; this service can only ever hand back the ref,
 * which the summary already exposes masked.
 *
 * The returned string must exist only inside the provider call: never in a
 * response, a log, an audit entry or a job payload (§4.3, §4.5).
 */
export async function resolveConnectionCredential(
  auth: Authorization,
  id: string,
): Promise<string | null> {
  assertIntegrationUuid(id, 'connectionId');
  const credentialRow = await fetchCredentialRow(auth, id);
  await assertTargetAffected(auth, credentialRow ? 1 : 0);
  const existing = credentialRow as ConnectionCredentialDbRow;
  if (existing.credential_ciphertext === null) return null;
  try {
    return decryptSecret(existing.credential_ciphertext);
  } catch (error) {
    throw fromVaultError(error);
  }
}
