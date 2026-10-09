import { randomBytes } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { checkWebhookUrlStatic } from '@/lib/jobs/handlers';
import { assertCanCreateConnection } from './config';
import { assertNoIdentityFields } from './connections';
import { assertIntegrationUuid, fromVaultError, IntegrationsError } from './errors';
import { validateSubscriptionEvents } from './fanout';
import { encryptSecret, serialiseEnvelope } from './secrets';

/**
 * Webhook subscriptions service — Phase 10 contract §4.1 (table 2), §4.4
 * (the routes these functions back), §4.5 (outbound), §4.7. Modelled on
 * the connections service (connections.ts) in this module.
 *
 * Trust boundaries, restated from the contract:
 *  - org_id ALWAYS comes from auth.ctx.orgId, never from caller input;
 *    every query additionally predicates on it (defence in depth on RLS).
 *  - The signing secret is GENERATED here (256-bit), returned to the
 *    caller exactly once — on create and on rotate, in a dedicated return
 *    shape that list/get never use — and stored ONLY as a Tier V vault
 *    envelope: serialised in signing_secret_ciphertext, with the nonce and
 *    key version duplicated into their columns (the connections.ts
 *    envelope-storage pattern; 0056 has no tag column, the envelope is the
 *    unit that keeps the tag with its ciphertext). Plaintext never reaches
 *    the database, a DTO, a log or an audit entry.
 *  - Vault not configured → typed NOT_CONFIGURED (§4.3): a subscription
 *    cannot be created or rotated without somewhere safe to keep its
 *    secret, so both fail before any row is written.
 *  - URL validation at create/update is the static SSRF check ONLY
 *    (checkWebhookUrlStatic — no DNS): a fail-fast for the admin's
 *    benefit. It is never a substitute for the delivery-time guard, which
 *    re-validates statically, resolves DNS, checks every address and pins
 *    the connection (jobs/handlers.ts, untouched by this wave).
 *  - Identity columns (id, org_id, created_by, created_at) are frozen by
 *    the 0056 BEFORE UPDATE trigger; the service guards them too
 *    (assertNoIdentityFields, shared with connections.ts) so an attempt
 *    fails as VALIDATION here rather than as an opaque 23514.
 *  - Id arguments are validated against the module's shared uuid schema
 *    (errors.ts assertIntegrationUuid) BEFORE any SQL runs, so a
 *    malformed id fails as the typed VALIDATION here rather than as
 *    Postgres 22P02 from a `${id}::uuid` cast (Wave J Finding 1, service
 *    half — the route half is http.ts parseIntegrationId).
 *  - Permission enforcement (integrations.view / integrations.manage)
 *    lives at the routes (Wave G) AND in the 0056 RLS policies; this
 *    service follows the connections.ts convention of not re-checking.
 */

const SELECT_COLUMNS = sql`
  s.id,
  s.url,
  s.events,
  s.active,
  s.signing_secret_ciphertext as "signingSecretCiphertext",
  s.created_by as "createdBy",
  s.created_at as "createdAt",
  s.updated_at as "updatedAt"
`;

const BASE_WHERE = (auth: Authorization) => sql`s.org_id = ${auth.ctx.orgId}::uuid`;

/** The only shape list/get ever return. No secret material, by construction. */
export interface WebhookSubscriptionSummary {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly hasSigningSecret: boolean;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The create/rotate return shape: the summary PLUS the signing secret.
 * This is the secret's one plaintext exit — the caller (an
 * integrations.manage route) shows it to the admin exactly once and never
 * persists or logs it. It is deliberately NOT part of the summary type,
 * so no list/get path can ever carry it.
 */
export interface WebhookSubscriptionWithSecret {
  readonly subscription: WebhookSubscriptionSummary;
  readonly signingSecret: string;
}

export interface WebhookSubscriptionPage {
  readonly rows: readonly WebhookSubscriptionSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

type SubscriptionDbRow = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  signingSecretCiphertext: string | null;
  createdBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Row → safe DTO. The ciphertext feeds ONLY the hasSigningSecret boolean;
 * nothing else about the credential columns survives this function — the
 * unit suite pins that.
 */
export function toSubscriptionSummary(row: SubscriptionDbRow): WebhookSubscriptionSummary {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    active: row.active,
    hasSigningSecret: row.signingSecretCiphertext !== null,
    createdBy: row.createdBy,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

/* ── Signing secrets ─────────────────────────────────────────────────────── */

/**
 * A fresh per-subscription signing secret: 256 bits of CSPRNG output,
 * base64url-encoded (43 chars — the module's token shape, cf. the inbound
 * endpoint keys). The receiver uses this exact string as its HMAC key;
 * the worker decrypts the stored envelope back to the same string.
 */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('base64url');
}

/* ── Array binding (the invitations precedent) ───────────────────────────── */

/**
 * Binds a JS string array as a Postgres text[] WITHOUT passing it as a
 * single parameter: drizzle's sql template serializes a JS array to one
 * string value, so `${events}::text[]` reaches Postgres as the malformed
 * array literal "deal.won" (22P02) and subscription creation fails. This
 * is the invitations service's uuidArrayParam lesson (P0-3), applied to
 * text: expand the array into one bound parameter per element inside an
 * array[...] constructor so every value stays bound and the cast is
 * correct. (validateSubscriptionEvents guarantees non-empty; the empty
 * branch keeps the helper total.)
 */
function textArrayParam(values: readonly string[]) {
  return values.length === 0
    ? sql`array[]::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}::text`),
        sql`, `,
      )}]`;
}

/* ── URL fail-fast (static SSRF check; delivery re-validates in full) ────── */

/**
 * Runs the delivery engine's static SSRF check as a create/update-time
 * fail-fast. Throws IntegrationsError VALIDATION with the field path as
 * the only detail (the taxonomy's static-message rule: the guard's reason
 * text is not surfaced).
 */
export function assertSubscriptionUrlAllowed(url: string): void {
  const check = checkWebhookUrlStatic(url);
  if (!check.allowed) {
    throw new IntegrationsError('VALIDATION', 'url');
  }
}

/* ── Input schemas (exported for Wave G route reuse) ─────────────────────── */

export const ListSubscriptionsQuerySchema = z.strictObject({
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const CreateSubscriptionInputSchema = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  events: z.array(z.string().min(1).max(64)).min(1).max(32),
});

export const UpdateSubscriptionInputSchema = z
  .strictObject({
    url: z.string().trim().min(1).max(2048).optional(),
    events: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'no fields to update' });

/* ── Internal row access ─────────────────────────────────────────────────── */

async function fetchSummaryRow(
  auth: Authorization,
  id: string,
): Promise<WebhookSubscriptionSummary | null> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<SubscriptionDbRow>(sql`
      select ${SELECT_COLUMNS}
      from public.integration_webhook_subscriptions s
      where ${BASE_WHERE(auth)}
        and s.id = ${id}::uuid
    `);
    const row = res.rows[0];
    return row ? toSubscriptionSummary(row) : null;
  });
}

/** Encrypts a fresh signing secret for storage; vault errors → taxonomy. */
function encryptSigningSecret(secret: string): {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
} {
  try {
    assertCanCreateConnection('vault');
    const envelope = encryptSecret(secret);
    return {
      ciphertext: serialiseEnvelope(envelope),
      nonce: envelope.nonce,
      keyVersion: envelope.keyVersion,
    };
  } catch (error) {
    throw fromVaultError(error);
  }
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listSubscriptions(
  auth: Authorization,
  input: unknown,
): Promise<WebhookSubscriptionPage> {
  const query = ListSubscriptionsQuerySchema.parse(input ?? {});
  const activeFilter = query.active !== undefined ? sql` and s.active = ${query.active}` : sql``;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<SubscriptionDbRow>(sql`
        select ${SELECT_COLUMNS}
        from public.integration_webhook_subscriptions s
        where ${BASE_WHERE(auth)}${activeFilter}
        order by s.created_at desc, s.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.integration_webhook_subscriptions s
        where ${BASE_WHERE(auth)}${activeFilter}
      `),
    ]);
    return {
      rows: rows.rows.map(toSubscriptionSummary),
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

/** Cross-tenant and missing ids are indistinguishable: NOT_FOUND (§4.7). */
export async function getSubscription(
  auth: Authorization,
  id: string,
): Promise<WebhookSubscriptionSummary> {
  assertIntegrationUuid(id, 'subscriptionId');
  const summary = await fetchSummaryRow(auth, id);
  await assertTargetAffected(auth, summary ? 1 : 0);
  return summary as WebhookSubscriptionSummary;
}

/* ── Create ──────────────────────────────────────────────────────────────── */

export async function createSubscription(
  auth: Authorization,
  input: unknown,
): Promise<WebhookSubscriptionWithSecret> {
  const data = CreateSubscriptionInputSchema.parse(input);
  assertSubscriptionUrlAllowed(data.url);
  const events = validateSubscriptionEvents(data.events);

  // The secret is generated BEFORE the insert and encrypted immediately;
  // the plaintext exists only in this frame and the return value.
  const signingSecret = generateSigningSecret();
  const stored = encryptSigningSecret(signingSecret);

  const id = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.integration_webhook_subscriptions (
        org_id, url, events, active,
        signing_secret_ciphertext, signing_secret_nonce, signing_secret_key_version,
        created_by
      ) values (
        ${auth.ctx.orgId}::uuid, ${data.url}, ${textArrayParam(events)}, true,
        ${stored.ciphertext}, ${stored.nonce}, ${stored.keyVersion},
        ${auth.ctx.personId}::uuid
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Webhook subscription creation failed.');
    return row.id;
  });

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.webhook_subscription.created',
      entityType: 'integration_webhook_subscription',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: { events: events.join(','), hasSigningSecret: true },
    },
    auth.meta,
  );
  const subscription = await getSubscription(auth, id);
  return { subscription, signingSecret };
}

/* ── Update (url / events / active) ──────────────────────────────────────── */

export async function updateSubscription(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<WebhookSubscriptionSummary> {
  assertIntegrationUuid(id, 'subscriptionId');
  if (typeof input === 'object' && input !== null) {
    assertNoIdentityFields(input as Record<string, unknown>);
  }
  const data = UpdateSubscriptionInputSchema.parse(input);
  const current = await fetchSummaryRow(auth, id);
  await assertTargetAffected(auth, current ? 1 : 0);

  const sets: SQL[] = [];
  const changedFields: string[] = [];
  if (data.url !== undefined) {
    assertSubscriptionUrlAllowed(data.url);
    sets.push(sql`url = ${data.url}`);
    changedFields.push('url');
  }
  if (data.events !== undefined) {
    const events = validateSubscriptionEvents(data.events);
    sets.push(sql`events = ${textArrayParam(events)}`);
    changedFields.push('events');
  }
  if (data.active !== undefined) {
    sets.push(sql`active = ${data.active}`);
    changedFields.push('active');
  }

  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.integration_webhook_subscriptions s
      set ${sql.join(sets, sql`, `)}
      where ${BASE_WHERE(auth)}
        and s.id = ${id}::uuid
      returning s.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.webhook_subscription.updated',
      entityType: 'integration_webhook_subscription',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: changedFields.join(',') },
    },
    auth.meta,
  );
  return getSubscription(auth, id);
}

/* ── Delete ──────────────────────────────────────────────────────────────── */

/** The 0056 deliveries → subscriptions FK (Postgres auto-name for the inline REFERENCES). */
export const DELIVERIES_SUBSCRIPTION_FK = 'integration_webhook_deliveries_subscription_id_fkey';

const SUBSCRIPTION_HAS_DELIVERIES_MESSAGE =
  'Subscription has delivery history; disable it instead of deleting.';

/**
 * True when `error` is the FK violation raised by deleting a subscription
 * that still has rows in integration_webhook_deliveries (0056 gives that FK
 * no ON DELETE action, deliberately: delivery history is an audit trail).
 *
 * Detection follows the repo's SQLSTATE precedent (auth/invitations.ts
 * sqlstateOf): drizzle wraps the driver error, so `code` may sit on the
 * error or on its cause. On top of the code, the constraint name is checked
 * whenever the driver provides one, so a 23503 raised by any OTHER FK in
 * the same statement shape is not misread as delivery history; when no
 * constraint name is available, the code alone decides (the precedent's
 * behaviour). Pure and exported for DB-free unit tests.
 */
export function isDeliveryHistoryConflict(error: unknown): boolean {
  let code: string | null = null;
  let constraint: string | null = null;
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const fields = candidate as { code?: unknown; constraint?: unknown } | null | undefined;
    if (!fields || typeof fields !== 'object') continue;
    if (code === null && typeof fields.code === 'string') code = fields.code;
    if (constraint === null && typeof fields.constraint === 'string') {
      constraint = fields.constraint;
    }
  }
  if (code !== '23503') return false;
  return constraint === null || constraint === DELIVERIES_SUBSCRIPTION_FK;
}

export async function deleteSubscription(auth: Authorization, id: string): Promise<void> {
  assertIntegrationUuid(id, 'subscriptionId');
  let affected: number;
  try {
    affected = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute(sql`
        delete from public.integration_webhook_subscriptions s
        where ${BASE_WHERE(auth)}
          and s.id = ${id}::uuid
        returning s.id
      `);
      return res.rowCount ?? 0;
    });
  } catch (e) {
    // A subscription with delivery history cannot be deleted (the history
    // is the audit trail); disabling it is the supported path. Everything
    // else propagates untouched.
    if (isDeliveryHistoryConflict(e)) {
      throw new IntegrationsError('CONFLICT', undefined, SUBSCRIPTION_HAS_DELIVERIES_MESSAGE);
    }
    throw e;
  }
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.webhook_subscription.deleted',
      entityType: 'integration_webhook_subscription',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: { credentialDestroyed: true },
    },
    auth.meta,
  );
}

/* ── Secret rotation ─────────────────────────────────────────────────────── */

/**
 * Generates a NEW signing secret, stores its envelope, and returns the
 * plaintext exactly once. The old envelope is overwritten in the same
 * UPDATE, so the old secret stops verifying the moment this commits —
 * receivers must be given the new secret before rotation, the standard
 * webhook-rotation caveat, recorded in the docs (Wave M).
 */
export async function rotateSubscriptionSecret(
  auth: Authorization,
  id: string,
): Promise<WebhookSubscriptionWithSecret> {
  assertIntegrationUuid(id, 'subscriptionId');
  const current = await fetchSummaryRow(auth, id);
  await assertTargetAffected(auth, current ? 1 : 0);

  const signingSecret = generateSigningSecret();
  const stored = encryptSigningSecret(signingSecret);

  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.integration_webhook_subscriptions s
      set signing_secret_ciphertext = ${stored.ciphertext},
          signing_secret_nonce = ${stored.nonce},
          signing_secret_key_version = ${stored.keyVersion}
      where ${BASE_WHERE(auth)}
        and s.id = ${id}::uuid
      returning s.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.webhook_subscription.secret_rotated',
      entityType: 'integration_webhook_subscription',
      entityId: id,
      result: 'SUCCESS',
      severity: 'HIGH',
      metadata: { hasSigningSecret: true },
    },
    auth.meta,
  );
  const subscription = await getSubscription(auth, id);
  return { subscription, signingSecret };
}
