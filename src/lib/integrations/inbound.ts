import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import { buildDedupKey, dispatchWorkflowEvent } from '@/lib/workflows/events';
import { assertIntegrationUuid, IntegrationsError } from './errors';
import { getProviderDefinition } from './providers';

/**
 * Inbound webhooks — Phase 10 contract §4.4 (route contract), §4.5
 * (inbound), §4.7 (security requirements). Wave W-in.
 *
 * ── THE TRUST MODEL ────────────────────────────────────────────────────────
 *
 * The endpoint key is the credential: a 256-bit random token carried in the
 * URL path (POST /api/integrations/inbound/[endpointKey]). Only its SHA-256
 * digest is stored (integration_connections.inbound_endpoint_key_hash,
 * migration 0058 — the invitations precedent). The organisation is resolved
 * ONLY from that digest; a payload-supplied org id is never read, let alone
 * trusted (§4.5). Until resolution there is no session and no org context:
 * the two reads that must happen before one exists go through the narrow
 * SECURITY DEFINER functions 0058 installed (integration_inbound_resolve_
 * endpoint / integration_inbound_find_receipt — the invitation_preview
 * pattern), reached via withAuthorizedDb under a zero context that can see
 * nothing else. The WRITES cross the same wall through 0060's companion
 * definers (integration_inbound_write_receipt /
 * integration_inbound_set_receipt_status — the notifications_insert
 * pattern): 0056 designed receipt writes to run under its tenant-only
 * policies (org_id = authz.org_id()), but authz.org_id() derives the org
 * FROM THE PERSON and this plane has none, so the policies can never
 * admit a pre-auth write. The definers derive the org inside — from the
 * connection row (re-verifying the presented digest against it) and from
 * the receipt row itself — and accept no org or person id at all.
 *
 * ── RESPONSES ARE UNIFORM AND UNREVEALING (§4.4) ───────────────────────────
 *
 *   accepted   200 { status: 'accepted' }        — PROCESSED, DUPLICATE, and
 *                                                  FAILED receipts alike:
 *                                                  the delivery is durably
 *                                                  recorded, and a sender
 *                                                  cannot fix our internal
 *                                                  failure, so it is not
 *                                                  signalled (a redelivery
 *                                                  of a FAILED receipt
 *                                                  reprocesses it — see
 *                                                  dedup below).
 *   rejected   400 { error: { code:
 *              'INBOUND_REJECTED', … } }         — ONE shape for an unknown
 *                                                  endpoint, a malformed
 *                                                  key, a failed
 *                                                  verification, a disabled
 *                                                  or disconnected
 *                                                  connection, an oversized
 *                                                  body and a non-JSON body.
 *                                                  The true reason lives
 *                                                  ONLY in the receipt row's
 *                                                  status — and unknown
 *                                                  endpoints leave no row at
 *                                                  all (there is no org to
 *                                                  record against, and
 *                                                  probers must not be able
 *                                                  to flood the table).
 *
 * ── IDEMPOTENCY (§4.5) ─────────────────────────────────────────────────────
 *
 * The receipt row is written FIRST (status RECEIVED), before any dispatch.
 * A delivery is a duplicate when (connection, external_event_id) already
 * has a receipt — enforced by 0056's partial UNIQUE index, with the 0058
 * dedup read deciding the outcome — or when the same payload hash arrived
 * inside INBOUND_DEDUP_WINDOW_HOURS (providers without event ids). A
 * duplicate of a PROCESSED receipt is answered 200 and never reprocessed;
 * a redelivery of a FAILED, interrupted (RECEIVED) or REJECTED receipt
 * REPROCESSES that row — this delivery must first pass verification and
 * the live gates again — so a sender retry is the recovery path. The
 * payload-hash duplicate
 * is recorded as its own DUPLICATE row; an external-id duplicate cannot be
 * (the unique index forbids the second row) — the original receipt is its
 * record. The raw body is never stored anywhere: payload_hash only (§4.1).
 *
 * ── DISPATCH ───────────────────────────────────────────────────────────────
 *
 * Processing dispatches ONE workflow event of the (Phase 10-enabled)
 * `webhook` trigger type under the connection's connected_by person — the
 * machine-actor shape of src/lib/jobs/workflow-jobs.ts
 * resolveJobExecutionAuth: a constructed Authorization for a principal the
 * database record itself names, whose live permissions the engine
 * re-derives on every call. The event payload is
 * { providerKey, connectionId, externalEventId, data } where `data` is the
 * parsed JSON body (non-object JSON is wrapped as { value }). The engine
 * dedups executions on the receipt-scoped dedup key, so reprocessing a
 * receipt can never double-run a workflow.
 */

/* ── Endpoint keys (the invitations token primitives, integrations-local) ── */

/** 256-bit token, base64url — 43 chars (≥ the §4.4 128-bit floor). */
export const ENDPOINT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh endpoint key. Returned to the issuing admin exactly once. */
export function generateEndpointKey(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form: SHA-256 hex digest. The plaintext never reaches the DB. */
export function hashEndpointKey(endpointKey: string): string {
  return createHash('sha256').update(endpointKey, 'utf8').digest('hex');
}

/** SHA-256 hex digest of a raw body — the only body trace ever stored. */
export function hashPayload(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

/**
 * Constant-time equality over two SHA-256 hex digests. Malformed input
 * (non-hex, wrong length) is simply unequal — this never throws, so a
 * verification path can call it on attacker-shaped values directly.
 */
export function endpointKeyHashesEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/* ── Body cap (§4.4: enforced BEFORE parsing) ────────────────────────────── */

export function isBodyWithinCap(rawBody: string, maxBodyBytes: number): boolean {
  return Buffer.byteLength(rawBody, 'utf8') <= maxBodyBytes;
}

/* ── Verification (§4.5) ─────────────────────────────────────────────────── */

export interface InboundVerificationInput {
  readonly mode: 'endpoint-token' | 'hmac-sha256';
  /** SHA-256 hex of the endpoint key presented in the URL. */
  readonly presentedEndpointKeyHash: string;
  /** SHA-256 hex stored on the resolved connection row. */
  readonly storedEndpointKeyHash: string | null;
  readonly rawBody: string;
  /** hmac-sha256 mode: the connection's decrypted secret (vault exit). */
  readonly secret?: string | null;
  /** hmac-sha256 mode: the `sha256=<hex>` signature header value. */
  readonly signatureHeader?: string | null;
}

/**
 * The §4.5 verifier, structured per registry mode. Pure — the caller
 * resolves the inputs. 'endpoint-token': the presented key's digest must
 * constant-time-match the stored digest (for the generic provider the key
 * alone authenticates). 'hmac-sha256': HMAC-SHA256 over the raw body with
 * the connection secret, constant-time compared; no V1 registry entry uses
 * it (no provider's inbound secret semantics exist yet), but the mode is
 * implemented here so a provider that declares it slots in without a new
 * verification path. No signature support ⇒ no inbound (§4.5) is enforced
 * by the registry: providers declare a mode or declare no inbound at all.
 */
export function verifyInboundRequest(input: InboundVerificationInput): boolean {
  if (input.mode === 'endpoint-token') {
    return (
      input.storedEndpointKeyHash !== null &&
      endpointKeyHashesEqual(input.presentedEndpointKeyHash, input.storedEndpointKeyHash)
    );
  }
  if (!input.secret || !input.signatureHeader) return false;
  const presented = input.signatureHeader.replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/.test(presented)) return false;
  const expected = createHmac('sha256', input.secret).update(input.rawBody, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
}

/* ── External event id + dedup decisions (pure) ──────────────────────────── */

const EXTERNAL_ID_HEADERS = ['x-event-id', 'x-webhook-id', 'idempotency-key'] as const;
const MAX_EXTERNAL_EVENT_ID_CHARS = 256;

/**
 * Where a delivery's idempotency id comes from, in precedence order: the
 * conventional id headers, else a top-level string `id` in a JSON object
 * body. Anything longer than the cap is ignored (treated as absent) rather
 * than truncated — a truncated id could collide two distinct events.
 */
export function extractExternalEventId(headers: Headers, parsedBody: unknown): string | null {
  for (const name of EXTERNAL_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value && value.length <= MAX_EXTERNAL_EVENT_ID_CHARS) return value;
  }
  if (typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)) {
    const id = (parsedBody as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_EXTERNAL_EVENT_ID_CHARS) {
      return id;
    }
  }
  return null;
}

export type InboundReceiptStatus =
  'RECEIVED' | 'PROCESSED' | 'REJECTED_SIGNATURE' | 'REJECTED_VALIDATION' | 'DUPLICATE' | 'FAILED';

export interface ExistingReceipt {
  readonly receiptId: string;
  readonly status: InboundReceiptStatus;
  /** 'external': matched on (connection, external event id). 'payload': same payload hash inside the window. */
  readonly matchKind: 'external' | 'payload';
}

export type DedupDecision =
  | { readonly action: 'process' }
  | { readonly action: 'duplicate' }
  | { readonly action: 'reprocess'; readonly receiptId: string };

/**
 * The dedup decision, as a pure function of the 0058 dedup read:
 *   external match, PROCESSED/DUPLICATE → duplicate (never reprocess)
 *   external match, FAILED/RECEIVED     → reprocess that receipt: it was
 *                                         accepted but never completed.
 *   external match, REJECTED_*          → reprocess that receipt: it was
 *                                         never dispatched, and THIS
 *                                         delivery has already passed
 *                                         verification and the live gates
 *                                         (the dedup read runs after
 *                                         them), so a corrected
 *                                         redelivery gets its chance
 *                                         instead of being silently
 *                                         dropped. The unique index
 *                                         forbids a second row, so the
 *                                         rejected row itself transitions
 *                                         RECEIVED → PROCESSED.
 *   payload match                       → duplicate
 *   no match                            → process
 */
export function decideDedup(existing: ExistingReceipt | null): DedupDecision {
  if (existing === null) return { action: 'process' };
  if (existing.matchKind === 'payload') return { action: 'duplicate' };
  if (existing.status === 'PROCESSED' || existing.status === 'DUPLICATE') {
    return { action: 'duplicate' };
  }
  return { action: 'reprocess', receiptId: existing.receiptId };
}

/* ── Uniform responses (§4.4) ────────────────────────────────────────────── */

export interface InboundHttpResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
}

/** The one acceptance shape: PROCESSED, DUPLICATE and FAILED alike. */
export function acceptedResult(): InboundHttpResult {
  return { httpStatus: 200, body: { status: 'accepted' } };
}

/** The one rejection shape: every refusal reason answers identically. */
export function rejectionResult(): InboundHttpResult {
  return {
    httpStatus: 400,
    body: {
      error: { code: 'INBOUND_REJECTED', message: 'The webhook delivery was rejected.' },
    },
  };
}

/* ── Issuance (authenticated; Wave G routes gate integrations.manage) ────── */

export interface IssuedEndpointKey {
  readonly connectionId: string;
  readonly providerKey: string;
  /** The plaintext endpoint key — shown to the admin exactly once. */
  readonly endpointKey: string;
}

/**
 * Issues (or rotates) the inbound endpoint key for a webhooks connection:
 * generates a fresh 256-bit token, stores only its SHA-256 digest in
 * inbound_endpoint_key_hash, and returns the plaintext exactly once.
 * Rotation IS re-issuance — overwriting the digest kills the old key.
 * Implemented here rather than connections.ts (Wave C owns that file);
 * the write runs under the caller's authorized context and the 0056
 * manage-gated UPDATE policy.
 */
export async function issueInboundEndpointKey(
  auth: Authorization,
  connectionId: string,
): Promise<IssuedEndpointKey> {
  assertIntegrationUuid(connectionId, 'connectionId');
  const id = connectionId;

  const current = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{
      provider_key: string;
      inbound_endpoint_key_hash: string | null;
    }>(sql`
      select c.provider_key, c.inbound_endpoint_key_hash
      from public.integration_connections c
      where c.org_id = ${auth.ctx.orgId}::uuid
        and c.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, current ? 1 : 0);
  const existing = current as { provider_key: string; inbound_endpoint_key_hash: string | null };

  const provider = getProviderDefinition(existing.provider_key);
  if (!provider || provider.inbound === null) {
    throw new IntegrationsError('VALIDATION', 'providerKey');
  }

  const endpointKey = generateEndpointKey();
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      update public.integration_connections c
      set inbound_endpoint_key_hash = ${hashEndpointKey(endpointKey)}
      where c.org_id = ${auth.ctx.orgId}::uuid
        and c.id = ${id}::uuid
      returning c.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'integration.inbound_endpoint_key.issued',
      entityType: 'integration_connection',
      entityId: id,
      result: 'SUCCESS',
      severity: 'HIGH',
      metadata: {
        providerKey: provider.key,
        rotated: existing.inbound_endpoint_key_hash !== null,
      },
    },
    auth.meta,
  );
  return { connectionId: id, providerKey: provider.key, endpointKey };
}

/* ── Receipt (pre-auth) ──────────────────────────────────────────────────── */

/**
 * The zero context used ONLY to reach the definer plane (0058's reads,
 * 0060's writes) before an org-person context exists — and, for the
 * writes, instead of one, since the receipt plane never has a person.
 * It satisfies no RLS policy (both ids are the nil UUID), which is the
 * point: if a future change replaced a definer with a raw table access,
 * a read would return nothing rather than everything, and a write would
 * be refused rather than admitted.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const RESOLUTION_CONTEXT: AuthContext = { personId: NIL_UUID, orgId: NIL_UUID, aal: 'aal1' };

/** Mirrors the 24h interval in 0058's find_receipt — move them together. */
export const INBOUND_DEDUP_WINDOW_HOURS = 24;

type ResolvedEndpoint = {
  connection_id: string;
  org_id: string;
  provider_key: string;
  status: string;
  config: Record<string, unknown>;
  connected_by: string | null;
  endpoint_key_hash: string;
};

function sqlstateOf(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Writes one receipt row through the 0060 definer. The definer derives
 * org_id / provider_key from the connection row and re-verifies the
 * presented digest against the stored one, so this helper neither carries
 * nor needs an org context. `processed` is the insert-time distinction
 * the pipeline has always made: terminal receipts (REJECTED_* /
 * DUPLICATE) are stamped processed_at at insert; the RECEIVED receipt is
 * not. A lost race against a concurrent identical delivery still
 * surfaces as SQLSTATE 23505 from the partial UNIQUE index (it
 * propagates through the definer unchanged) — the caller maps it.
 */
async function recordReceipt(row: {
  connectionId: string;
  endpointKeyHash: string;
  externalEventId: string | null;
  payloadHash: string;
  status: InboundReceiptStatus;
  processed: boolean;
}): Promise<string> {
  return withAuthorizedDb(RESOLUTION_CONTEXT, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      select public.integration_inbound_write_receipt(
        ${row.connectionId}::uuid, ${row.endpointKeyHash}, ${row.externalEventId},
        ${row.payloadHash}, ${row.status}, ${row.processed}
      ) as id
    `);
    const inserted = res.rows[0];
    if (!inserted) throw new Error('Integration inbound receipt insert failed.');
    return inserted.id;
  });
}

/**
 * Transitions one receipt through the 0060 definer, which derives the
 * receipt's org from the row itself. mark_processed is always true here:
 * the direct UPDATE this replaced stamped processed_at on EVERY
 * transition (including the reprocess reset to RECEIVED), and the
 * definer's flag preserves that behaviour exactly.
 */
async function setReceiptStatus(receiptId: string, status: InboundReceiptStatus): Promise<void> {
  await withAuthorizedDb(RESOLUTION_CONTEXT, async (tx) => {
    await tx.execute(sql`
      select public.integration_inbound_set_receipt_status(
        ${receiptId}::uuid, ${status}, true
      )
    `);
  });
}

/**
 * The pre-auth receipt pipeline (§4.4/§4.5). Never throws for a
 * sender-shaped problem — those become the uniform rejection; throws only
 * on infrastructure failure, which the route answers with an opaque 500.
 * The body is taken as a raw string: nothing here parses it before the cap
 * check and the payload hash.
 */
export async function receiveInbound(
  endpointKey: string,
  rawBody: string,
  headers: Headers,
): Promise<InboundHttpResult> {
  // A malformed key cannot resolve; answer without touching the database.
  if (!ENDPOINT_KEY_PATTERN.test(endpointKey)) return rejectionResult();
  const presentedHash = hashEndpointKey(endpointKey);

  // Resolution: endpoint hash → connection → org. Nothing about the org is
  // taken from the request; the payload is not even parsed yet.
  const resolved = await withAuthorizedDb(RESOLUTION_CONTEXT, async (tx) => {
    const res = await tx.execute<ResolvedEndpoint>(sql`
      select connection_id, org_id, provider_key, status, config,
             connected_by, endpoint_key_hash
      from public.integration_inbound_resolve_endpoint(${presentedHash})
    `);
    return res.rows[0] ?? null;
  });
  if (resolved === null) return rejectionResult();

  const provider = getProviderDefinition(resolved.provider_key);
  if (!provider || provider.inbound === null) return rejectionResult();
  const payloadHash = hashPayload(rawBody);
  const baseRow = {
    connectionId: resolved.connection_id,
    endpointKeyHash: presentedHash,
    payloadHash,
  };

  // Verification (§4.5), per the registry mode. In endpoint-token mode the
  // resolution lookup already matched on the digest; the constant-time
  // compare here is the verification step proper — and the only step an
  // hmac-sha256 provider would change.
  const verified = verifyInboundRequest({
    mode: provider.inbound.verification,
    presentedEndpointKeyHash: presentedHash,
    storedEndpointKeyHash: resolved.endpoint_key_hash,
    rawBody,
  });
  if (!verified) {
    await recordReceipt({
      ...baseRow,
      externalEventId: null,
      status: 'REJECTED_SIGNATURE',
      processed: true,
    });
    return rejectionResult();
  }

  // The connection must be live and inbound-enabled; a disconnected or
  // paused endpoint refuses exactly like an unknown one.
  const inboundEnabled =
    typeof resolved.config === 'object' &&
    resolved.config !== null &&
    (resolved.config as Record<string, unknown>).inboundEnabled !== false;
  if (resolved.status !== 'CONNECTED' || !inboundEnabled) {
    await recordReceipt({
      ...baseRow,
      externalEventId: null,
      status: 'REJECTED_VALIDATION',
      processed: true,
    });
    return rejectionResult();
  }

  // Body cap BEFORE parsing (§4.4) — the resolved provider's own cap.
  if (!isBodyWithinCap(rawBody, provider.inbound.maxBodyBytes)) {
    await recordReceipt({
      ...baseRow,
      externalEventId: null,
      status: 'REJECTED_VALIDATION',
      processed: true,
    });
    return rejectionResult();
  }

  // The generic receiver speaks JSON; a non-JSON body is a validation
  // refusal, recorded like the others.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    await recordReceipt({
      ...baseRow,
      externalEventId: null,
      status: 'REJECTED_VALIDATION',
      processed: true,
    });
    return rejectionResult();
  }
  const externalEventId = extractExternalEventId(headers, parsedBody);

  // Dedup read (0058 definer): external-id match first, payload window next.
  const existing = await withAuthorizedDb(RESOLUTION_CONTEXT, async (tx) => {
    const res = await tx.execute<{
      receipt_id: string;
      receipt_status: InboundReceiptStatus;
      match_kind: 'external' | 'payload';
    }>(sql`
      select receipt_id, receipt_status, match_kind
      from public.integration_inbound_find_receipt(
        ${resolved.connection_id}::uuid, ${externalEventId}, ${payloadHash}
      )
    `);
    const row = res.rows[0];
    return row
      ? { receiptId: row.receipt_id, status: row.receipt_status, matchKind: row.match_kind }
      : null;
  });
  const decision = decideDedup(existing);

  if (decision.action === 'duplicate') {
    if (existing?.matchKind === 'payload') {
      // Recorded as its own DUPLICATE row (§4.5). An external-id duplicate
      // gets no second row — the partial UNIQUE index forbids it, and the
      // original receipt is its record.
      await recordReceipt({
        ...baseRow,
        externalEventId,
        status: 'DUPLICATE',
        processed: true,
      });
    }
    return acceptedResult();
  }

  // Receipt first (§4.5): the row exists before any processing, so a crash
  // mid-dispatch leaves a RECEIVED receipt a redelivery can reprocess.
  let receiptId: string;
  if (decision.action === 'reprocess') {
    receiptId = decision.receiptId;
    await setReceiptStatus(receiptId, 'RECEIVED');
  } else {
    try {
      receiptId = await recordReceipt({
        ...baseRow,
        externalEventId,
        status: 'RECEIVED',
        processed: false,
      });
    } catch (error) {
      // Lost a race against a concurrent identical delivery: the partial
      // UNIQUE index fired. The winner's receipt is the record; this
      // delivery is a duplicate (or a reprocess candidate the winner is
      // already handling).
      if (sqlstateOf(error) === '23505') return acceptedResult();
      throw error;
    }
  }

  // Dispatch: one `webhook` workflow event under the connection's
  // connected_by principal (the workflow-jobs machine-actor shape). With no
  // connected_by there is no principal whose authority could run a
  // workflow — the receipt fails closed rather than inventing one.
  if (resolved.connected_by === null) {
    await setReceiptStatus(receiptId, 'FAILED');
    return acceptedResult();
  }
  const requestId = randomUUID();
  const meta: RequestMetadata = { requestId, ip: null, userAgent: null };
  const actor: Authorization = {
    ctx: { personId: resolved.connected_by, orgId: resolved.org_id, aal: 'aal1' },
    permission: 'workflows.execute',
    scope: 'GLOBAL',
    aal: 'aal1',
    requestId,
    meta,
  };
  const data =
    typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)
      ? parsedBody
      : { value: parsedBody };
  try {
    // dispatchWorkflowEvent never throws (engine doctrine D3); the engine
    // records per-workflow outcomes on its own execution rows, and its
    // (workflow, dedupKey) constraint makes reprocessing idempotent.
    await dispatchWorkflowEvent(actor, {
      type: 'webhook',
      entityType: null,
      entityId: null,
      dedupKey: buildDedupKey('integration_inbound_event', receiptId),
      payload: {
        providerKey: resolved.provider_key,
        connectionId: resolved.connection_id,
        externalEventId,
        data,
      },
    });
    await setReceiptStatus(receiptId, 'PROCESSED');
  } catch (error) {
    console.error('[integrations/inbound] dispatch pipeline failed', {
      connectionId: resolved.connection_id,
      receiptId,
      name: error instanceof Error ? error.name : typeof error,
    });
    await setReceiptStatus(receiptId, 'FAILED');
  }
  return acceptedResult();
}
