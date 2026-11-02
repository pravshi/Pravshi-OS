/**
 * Website Platform Contracts — Public Domain Events.
 *
 * Emitted across the domain events port for website publishing, DNS lifecycle,
 * and public inbound lead ingestion.
 */

export interface DomainVerifiedEvent {
  readonly type: 'website.domain.verified';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly siteId: string;
    readonly customDomain: string;
    readonly verifiedAt: string;
  };
}

export interface SitePublishedEvent {
  readonly type: 'website.site.published';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly siteId: string;
    readonly pageId: string;
    readonly slug: string;
    readonly publishedVersion: number;
    readonly publishedAt: string;
  };
}

export interface PublicInquiryReceivedEvent {
  readonly type: 'website.inquiry.received';
  readonly organizationId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly inquiryId: string;
    readonly siteId: string;
    readonly entityType: 'listing' | 'program' | 'general';
    readonly entityId?: string;
    readonly contact: {
      readonly name: string;
      readonly email: string;
      readonly phone: string;
    };
    readonly message: string;
  };
}

export type WebsitePlatformEvent =
  DomainVerifiedEvent | SitePublishedEvent | PublicInquiryReceivedEvent;
