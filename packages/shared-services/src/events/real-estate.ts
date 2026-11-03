/**
 * Pravshi OS — Real Estate Domain Event Port & Trusted Envelope Adapter (Layer 3).
 *
 * Implements server-side trusted envelope construction from authorized context and
 * canonical identity adaptation into the workflow dispatcher port.
 */
import { randomUUID } from 'node:crypto';
import type { Authorization } from '@/lib/authz/require-permission';
import {
  buildRealEstateDedupKey,
  RealEstateDomainEventEnvelopeSchema,
  type RealEstateDomainEventEnvelope,
  type RealEstateEntityType,
  type RealEstateEventType,
} from '@pravshi/contracts';
import {
  dispatchWorkflowEvent,
  type DomainWorkflowEventInput,
  type DomainWorkflowEventType,
} from './index';

/**
 * Creates a server-verified, canonical Real Estate domain event envelope.
 *
 * All identity and authority fields (`id`, `orgId`, `actorPersonId`, `occurredAt`,
 * `entityVersion`, `dedupKey`) are strictly server-derived from the verified
 * `Authorization` context and persistence version. Client-supplied payloads cannot
 * forge or override these trusted envelope metadata fields.
 */
export function createTrustedRealEstateEventEnvelope<
  TType extends RealEstateEventType = RealEstateEventType,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>(args: {
  readonly auth: Authorization;
  readonly type: TType;
  readonly entityType: RealEstateEntityType;
  readonly entityId: string;
  readonly entityVersion: number;
  readonly payload: TPayload;
  readonly occurredAt?: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): RealEstateDomainEventEnvelope<TType, TPayload> {
  const orgId = args.auth.ctx.orgId;
  const actorPersonId = args.auth.ctx.personId;
  const occurredAt = (args.occurredAt ?? new Date()).toISOString();
  const id = randomUUID();
  const dedupKey = buildRealEstateDedupKey(
    orgId,
    args.entityType,
    args.entityId,
    args.entityVersion,
  );

  const envelope: RealEstateDomainEventEnvelope<TType, TPayload> = {
    id,
    orgId,
    actorPersonId,
    occurredAt,
    entityType: args.entityType,
    entityId: args.entityId,
    entityVersion: args.entityVersion,
    type: args.type,
    dedupKey,
    payload: args.payload,
    metadata: args.metadata,
  };

  // Validate envelope invariants (UUIDs, ISO timestamp, integer version)
  RealEstateDomainEventEnvelopeSchema.parse(envelope);

  return envelope;
}

/**
 * Hands a canonical Real Estate domain event to the workflow dispatcher port.
 *
 * Reconciles the Real Estate event envelope with the workflow engine contract:
 * Preserves the canonical `dedupKey`, `entityType`, `entityId`, and `payload`
 * without generating duplicate event identities or deviating timestamps.
 */
export async function dispatchRealEstateWorkflowEvent(
  auth: Authorization,
  envelope: RealEstateDomainEventEnvelope,
): Promise<void> {
  const input: DomainWorkflowEventInput = {
    type: envelope.type as DomainWorkflowEventType,
    entityType: envelope.entityType,
    entityId: envelope.entityId,
    dedupKey: envelope.dedupKey,
    payload: envelope.payload,
  };

  await dispatchWorkflowEvent(auth, input);
}
