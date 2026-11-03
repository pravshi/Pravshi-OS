/**
 * Real Estate Contracts — Public Domain Events.
 *
 * Emitted across the domain events port for workflow orchestration, audit logging,
 * and outbound notifications. Tenant-stamped by authorization context.
 *
 * All domain event types, Zod payload schemas, and canonical envelope contracts
 * are frozen in Layer 3 (`@pravshi/contracts`).
 */
export {
  REAL_ESTATE_EVENT_TYPES,
  RealEstateEventTypeSchema,
  DEFERRED_RE_WORKFLOW_TRIGGER_TYPES,
  DEFERRED_RE_INTEGRATION_EVENT_KEYS,
  REAL_ESTATE_ENTITY_TYPES,
  RealEstateEntityTypeSchema,
  RealEstateDomainEventEnvelopeSchema,
  buildRealEstateDedupKey,
  type RealEstateEventType,
  type DeferredRealEstateWorkflowTriggerType,
  type DeferredRealEstateIntegrationEventKey,
  type RealEstateEntityType,
  type RealEstateDomainEventEnvelope,
} from '@pravshi/contracts';

export interface ListingPublishedEvent {
  readonly type: 'real_estate.listing.published';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly listingId: string;
    readonly title: string;
    readonly slug: string;
    readonly category: 'sale' | 'rental' | 'lease';
    readonly propertyType: string;
    readonly basePrice: number;
    readonly currency: string;
    readonly city: string;
    readonly state: string;
  };
}

export interface SiteVisitCompletedEvent {
  readonly type: 'real_estate.site_visit.completed';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly siteVisitId: string;
    readonly listingId: string;
    readonly leadOrContactId: string;
    readonly agentId: string;
    readonly rating: number;
    readonly interestLevel: 'high' | 'medium' | 'low' | 'not_interested';
    readonly verifiedAt: string;
  };
}

export interface DealClosedWonEvent {
  readonly type: 'real_estate.deal.closed_won';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly dealId: string;
    readonly listingId: string;
    readonly contactId: string;
    readonly agreedPrice: number;
    readonly currency: string;
    readonly totalCommissionDistributed: number;
    readonly bookingTokenId?: string;
  };
}

export type RealEstateEvent = ListingPublishedEvent | SiteVisitCompletedEvent | DealClosedWonEvent;
