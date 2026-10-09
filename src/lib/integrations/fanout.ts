import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { enqueueJob } from '@/lib/jobs/queue';
import { assertIntegrationUuid, IntegrationsError } from './errors';

/**
 * Outbound webhook fan-out — Phase 10 contract §4.5 (outbound), §4.7.
 *
 * Domain events raised inside the product are fanned out to the org's
 * ACTIVE webhook subscriptions: one `integration_webhook_deliveries` link
 * row and one Phase 6 `webhook` job per subscribed subscription. The job
 * payload carries { subscriptionId, deliveryId, url, body } — the body is
 * the event envelope — and NEVER the subscription's signing secret (§4.5
 * [DECISION]: operators can read jobs.payload; the handler resolves and
 * decrypts the secret inside the worker, see jobs/handlers.ts + migration
 * 0059).
 *
 * ── EVENT CATALOGUE (V1) ─────────────────────────────────────────────────
 *
 * Fixed against the emission points that actually exist in the codebase
 * (verified by Wave W-out; the hooks live at those points):
 *
 *   workflow.completed  workflows/engine.ts — a run finishes SUCCEEDED
 *   workflow.failed     workflows/engine.ts — a run finishes FAILED
 *   deal.won            crm/deals.ts updateDeal + crm/pipelines.ts
 *                       moveDealToStage — deal.stage_changed with the
 *                       pipeline stage's is_won flag (never the stage name)
 *   deal.lost           same points, the is_lost flag
 *   task.completed      work/tasks.ts updateTask + moveTask — a task's
 *                       status becomes 'done'
 *
 * The candidate list in §4.5 needed no substitutions: every key maps to a
 * real emission point above.
 *
 * ── AUTHORITY (D2 — the platform doctrine, Phase 8 precedent) ────────────
 *
 * Fan-out runs under the Authorization that raised the event — no
 * synthetic actor, no privilege escalation. Subscription discovery is
 * governed by the 0056 SELECT policy (org + integrations.view) and job
 * creation by enqueueJob's jobs.create gate, exactly as the Phase 8
 * notifications fan-out (notifications/service.ts) runs under its
 * caller's authority. The deliveries INSERT policy is tenant-only (0056),
 * written for precisely this writer. A raising context that cannot see
 * subscriptions or create jobs therefore fans out to nothing — fail-closed
 * and visible in the returned counts — rather than silently escalating.
 *
 * ── FAILURE CONTAINMENT (D3) ─────────────────────────────────────────────
 *
 * emitIntegrationEvent NEVER throws: a webhook fault must not break the
 * originating mutation (the workflow dispatcher's own doctrine). Every
 * failure is counted in the result and logged with ids only — never with
 * the event body, a URL query string, or any credential material.
 */

/* ── Event catalogue ─────────────────────────────────────────────────────── */

export const INTEGRATION_EVENT_KEYS = [
  'workflow.completed',
  'workflow.failed',
  'deal.won',
  'deal.lost',
  'task.completed',
] as const;
export type IntegrationEventKey = (typeof INTEGRATION_EVENT_KEYS)[number];

const INTEGRATION_EVENT_KEY_SET: ReadonlySet<string> = new Set(INTEGRATION_EVENT_KEYS);

export function isIntegrationEventKey(value: unknown): value is IntegrationEventKey {
  return typeof value === 'string' && INTEGRATION_EVENT_KEY_SET.has(value);
}

/**
 * The deliveries event_key recorded for workflow `webhook` ACTION sends
 * (actions.ts). Not a subscribable catalogue key — an action send is
 * addressed to one subscription directly, not fanned out — it exists so
 * the delivery history (§4.4 read model) can tell the two apart.
 */
export const WORKFLOW_ACTION_EVENT_KEY = 'workflow.action';

/**
 * Validates a subscription's event list against the catalogue. Returns the
 * keys as catalogue keys; throws IntegrationsError VALIDATION (detail =
 * the field path only) on an empty list, a duplicate, or an unknown key —
 * a subscription to an event that can never fire is a configuration error,
 * not a runtime state.
 */
export function validateSubscriptionEvents(
  events: readonly string[],
): readonly IntegrationEventKey[] {
  if (events.length === 0) throw new IntegrationsError('VALIDATION', 'events');
  const seen = new Set<string>();
  for (const key of events) {
    if (!isIntegrationEventKey(key)) throw new IntegrationsError('VALIDATION', 'events');
    if (seen.has(key)) throw new IntegrationsError('VALIDATION', 'events');
    seen.add(key);
  }
  return events as readonly IntegrationEventKey[];
}

/* ── Envelope ────────────────────────────────────────────────────────────── */

/** The §4.5 delivery envelope — the HTTP body of every fan-out delivery. */
export interface WebhookEventEnvelope {
  /** The delivery row id — the receiver's dedup key. */
  readonly id: string;
  readonly type: string;
  /** ISO-8601 emission time. */
  readonly created_at: string;
  readonly org_id: string;
  readonly data: Record<string, unknown>;
}

export function buildEventEnvelope(args: {
  deliveryId: string;
  eventKey: string;
  orgId: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
}): WebhookEventEnvelope {
  return {
    id: args.deliveryId,
    type: args.eventKey,
    created_at: (args.occurredAt ?? new Date()).toISOString(),
    org_id: args.orgId,
    data: args.data,
  };
}

/* ── Dedup ───────────────────────────────────────────────────────────────── */

/** The jobs dedup_key cap (EnqueueJobInputSchema). */
const MAX_DEDUP_KEY_CHARS = 256;

/**
 * Deterministic dedup key for one (event, subscription, event instance)
 * delivery: re-emitting the same event instance — a retried mutation, a
 * redelivered source event — maps to the same key, so the queue returns
 * the existing job instead of double-sending (the queue's (org_id,
 * dedup_key) unique index arbitrates). Overlong keys are hashed, not
 * sliced, so distinct keys stay distinct (the engine's boundedDedupKey
 * pattern).
 */
export function buildFanoutDedupKey(
  eventKey: string,
  subscriptionId: string,
  eventInstanceId: string,
): string {
  const full = `wh:${eventKey}:${subscriptionId}:${eventInstanceId}`;
  if (full.length <= MAX_DEDUP_KEY_CHARS) return full;
  const digest = createHash('sha256').update(full).digest('hex');
  return `${full.slice(0, MAX_DEDUP_KEY_CHARS - digest.length - 1)}:${digest}`;
}

/* ── Subscription targets ────────────────────────────────────────────────── */

export type WebhookSubscriptionTarget = {
  readonly id: string;
  readonly url: string;
  readonly active: boolean;
};

type SubscriptionRow = WebhookSubscriptionTarget & {
  events: string[];
};

/**
 * The fan-out predicate, pure so the suite can pin it: a subscription
 * receives an event when it is ACTIVE and its event list contains the key.
 * (emitIntegrationEvent's SQL pre-filters on org + active; this is the
 * same predicate over the returned rows, and the single definition the
 * action path's target check shares.)
 */
export function selectSubscriptionsForEvent(
  rows: readonly SubscriptionRow[],
  eventKey: string,
): WebhookSubscriptionTarget[] {
  return rows
    .filter((row) => row.active && row.events.includes(eventKey))
    .map((row) => ({ id: row.id, url: row.url, active: row.active }));
}

/**
 * Loads one subscription as a delivery target under the caller's auth.
 * Missing and cross-tenant ids are indistinguishable: NOT_FOUND (§4.7),
 * via the repo's assertTargetAffected pattern.
 */
export async function getSubscriptionTarget(
  auth: Authorization,
  id: string,
): Promise<WebhookSubscriptionTarget> {
  assertIntegrationUuid(id, 'subscriptionId');
  const target = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<WebhookSubscriptionTarget>(sql`
      select s.id, s.url, s.active
      from public.integration_webhook_subscriptions s
      where s.org_id = ${auth.ctx.orgId}::uuid
        and s.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, target ? 1 : 0);
  return target as WebhookSubscriptionTarget;
}

/* ── One delivery: enqueue + link ────────────────────────────────────────── */

export interface SubscriptionDeliveryInput {
  /** The HTTP body: the event envelope (fan-out) or the action's body. */
  readonly body: unknown;
  /** Recorded on the deliveries row (a catalogue key, or workflow.action). */
  readonly eventKey: string;
  /** Deterministic per (subscription, event instance) — see above. */
  readonly dedupKey: string;
  /** Pre-generated when the caller must know it first (the envelope id). */
  readonly deliveryId?: string;
}

export interface SubscriptionDeliveryResult {
  readonly jobId: string;
  readonly deliveryId: string;
  /** True when the dedup key already had a job — nothing new was linked. */
  readonly duplicate: boolean;
}

/**
 * Enqueues the `webhook` job for one subscription and writes the
 * deliveries link row. The payload carries ids + url + body only — never
 * the signing secret (§4.5). Ordering is forced by the schema: the link
 * row's job_id is a NOT NULL FK, so the job is enqueued first; on a dedup
 * hit the returned job is the ORIGINAL enqueue (its payload carries the
 * original deliveryId), the original link row already stands, and this
 * call links nothing new.
 *
 * Throws whatever enqueueJob / the insert throws — the fan-out entry
 * point below contains failures per subscription; direct callers (the
 * workflow action executor) surface them as step failures.
 */
export async function deliverToSubscription(
  auth: Authorization,
  target: WebhookSubscriptionTarget,
  input: SubscriptionDeliveryInput,
): Promise<SubscriptionDeliveryResult> {
  const deliveryId = input.deliveryId ?? randomUUID();
  const job = await enqueueJob(auth, {
    type: 'webhook',
    payload: {
      subscriptionId: target.id,
      deliveryId,
      url: target.url,
      body: input.body,
    },
    dedupKey: input.dedupKey,
  });

  const storedDeliveryId = job.payload['deliveryId'];
  if (typeof storedDeliveryId === 'string' && storedDeliveryId !== deliveryId) {
    return { jobId: job.id, deliveryId: storedDeliveryId, duplicate: true };
  }

  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.integration_webhook_deliveries (
        id, org_id, subscription_id, job_id, event_key
      ) values (
        ${deliveryId}::uuid, ${auth.ctx.orgId}::uuid, ${target.id}::uuid,
        ${job.id}::uuid, ${input.eventKey}
      )
    `);
  });
  return { jobId: job.id, deliveryId, duplicate: false };
}

/* ── Fan-out entry point ─────────────────────────────────────────────────── */

export interface IntegrationEventEmission {
  readonly eventKey: IntegrationEventKey;
  /** Active subscriptions subscribed to the event (visible to the caller). */
  readonly matched: number;
  readonly enqueued: number;
  /** Deliveries the queue deduped to an earlier enqueue of the same event instance. */
  readonly duplicates: number;
  readonly failed: number;
  readonly jobIds: readonly string[];
  readonly deliveryIds: readonly string[];
}

/**
 * The org-level outbound kill switch (providers/webhooks.ts config):
 * honoured when a `webhooks` connection is visible under the caller's
 * auth and its config explicitly disables outbound. An absent or
 * invisible connection does not block fan-out — subscriptions are the
 * deliverable state; the connection is the provider's health surface.
 */
async function isOrgOutboundEnabled(auth: Authorization): Promise<boolean> {
  const rows = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ config: Record<string, unknown> }>(sql`
      select c.config
      from public.integration_connections c
      where c.org_id = ${auth.ctx.orgId}::uuid
        and c.provider_key = 'webhooks'
      limit 1
    `);
    return res.rows;
  });
  const config = rows[0]?.config;
  return !(config !== undefined && config['outboundEnabled'] === false);
}

/**
 * Fans one domain event out to the org's active subscriptions. NEVER
 * throws (D3, see the header). Callers pass a stable `eventInstanceId`
 * whenever the event instance has a natural identity (a workflow
 * execution id, a stage-history row id) so re-emission dedups; without
 * one, each call is a distinct event instance.
 */
export async function emitIntegrationEvent(
  auth: Authorization,
  eventKey: IntegrationEventKey,
  data: Record<string, unknown>,
  options?: { readonly eventInstanceId?: string },
): Promise<IntegrationEventEmission> {
  const empty: IntegrationEventEmission = {
    eventKey,
    matched: 0,
    enqueued: 0,
    duplicates: 0,
    failed: 0,
    jobIds: [],
    deliveryIds: [],
  };
  try {
    if (!(await isOrgOutboundEnabled(auth))) {
      console.info(
        `[integrations] fan-out paused by org kill switch event=${eventKey} org=${auth.ctx.orgId}`,
      );
      return empty;
    }

    const rows = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute<SubscriptionRow>(sql`
        select s.id, s.url, s.events, s.active
        from public.integration_webhook_subscriptions s
        where s.org_id = ${auth.ctx.orgId}::uuid
          and s.active = true
        order by s.created_at asc, s.id asc
      `);
      return res.rows;
    });
    const targets = selectSubscriptionsForEvent(rows, eventKey);
    if (targets.length === 0) return { ...empty, matched: 0 };

    const eventInstanceId = options?.eventInstanceId ?? randomUUID();
    let enqueued = 0;
    let duplicates = 0;
    let failed = 0;
    const jobIds: string[] = [];
    const deliveryIds: string[] = [];

    for (const target of targets) {
      try {
        const deliveryId = randomUUID();
        const envelope = buildEventEnvelope({
          deliveryId,
          eventKey,
          orgId: auth.ctx.orgId,
          data,
        });
        const result = await deliverToSubscription(auth, target, {
          body: envelope,
          eventKey,
          dedupKey: buildFanoutDedupKey(eventKey, target.id, eventInstanceId),
          deliveryId,
        });
        jobIds.push(result.jobId);
        deliveryIds.push(result.deliveryId);
        if (result.duplicate) duplicates += 1;
        else enqueued += 1;
      } catch (error) {
        failed += 1;
        console.warn(
          `[integrations] fan-out delivery failed event=${eventKey} ` +
            `subscription=${target.id} org=${auth.ctx.orgId}`,
          { error },
        );
      }
    }

    return {
      eventKey,
      matched: targets.length,
      enqueued,
      duplicates,
      failed,
      jobIds,
      deliveryIds,
    };
  } catch (error) {
    console.warn(`[integrations] fan-out failed event=${eventKey} org=${auth.ctx.orgId}`, {
      error,
    });
    return { ...empty, failed: 1 };
  }
}
