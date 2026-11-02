/**
 * Real Estate Domain — Site Visit Scheduling, Verification, and Feedback.
 *
 * Implements scheduling rules, verification state transitions, and client interest scoring.
 */

export const SITE_VISIT_STATUSES = [
  'requested',
  'confirmed',
  'rescheduled',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type SiteVisitStatus = (typeof SITE_VISIT_STATUSES)[number];

export const VERIFICATION_METHODS = [
  'otp',
  'agent_checkin',
  'client_signature',
  'geo_proximity',
] as const;
export type SiteVisitVerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const CLIENT_INTEREST_LEVELS = ['high', 'medium', 'low', 'not_interested'] as const;
export type ClientInterestLevel = (typeof CLIENT_INTEREST_LEVELS)[number];

export interface SiteVisitFeedback {
  readonly rating: number; // 1 to 5
  readonly interestLevel: ClientInterestLevel;
  readonly notes?: string;
  readonly followUpAction?: string;
  readonly followUpDate?: Date;
}

export interface SiteVisit {
  readonly id: string;
  readonly organizationId: string;
  readonly listingId: string;
  readonly unitId?: string;
  readonly leadOrContactId: string;
  readonly agentId: string;
  readonly scheduledStartTime: Date;
  readonly scheduledEndTime: Date;
  readonly status: SiteVisitStatus;
  readonly verificationMethod?: SiteVisitVerificationMethod;
  readonly verifiedAt?: Date;
  readonly feedback?: SiteVisitFeedback;
  readonly cancellationReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class SiteVisitDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SiteVisitDomainError';
  }
}

/**
 * Invariant: Start time must be before end time, duration at least 15 minutes, not in the past when scheduling.
 */
export function validateSiteVisitTimeWindow(
  start: Date,
  end: Date,
  referenceDate: Date = new Date(),
): void {
  if (start >= end) {
    throw new SiteVisitDomainError(
      'Site visit start time must precede end time',
      'INVALID_TIME_WINDOW',
    );
  }
  const durationMinutes = (end.getTime() - start.getTime()) / (1000 * 60);
  if (durationMinutes < 15) {
    throw new SiteVisitDomainError(
      'Site visit duration must be at least 15 minutes',
      'DURATION_TOO_SHORT',
    );
  }
  if (durationMinutes > 480) {
    throw new SiteVisitDomainError(
      'Site visit duration cannot exceed 8 hours',
      'DURATION_TOO_LONG',
    );
  }
  if (start.getTime() < referenceDate.getTime() - 60000) {
    throw new SiteVisitDomainError(
      'Cannot schedule a site visit in the past',
      'CANNOT_SCHEDULE_PAST',
    );
  }
}

/**
 * Invariant: Site visit completion requires verification timestamp and feedback.
 */
export function assertCanCompleteSiteVisit(visit: SiteVisit): void {
  if (visit.status === 'cancelled' || visit.status === 'no_show') {
    throw new SiteVisitDomainError(
      `Cannot complete a site visit in status ${visit.status}`,
      'CANNOT_COMPLETE_INACTIVE',
    );
  }
  if (!visit.verifiedAt) {
    throw new SiteVisitDomainError(
      'Site visit must be verified before completion',
      'VERIFICATION_REQUIRED',
    );
  }
  if (!visit.feedback) {
    throw new SiteVisitDomainError(
      'Client feedback is required to mark site visit complete',
      'FEEDBACK_REQUIRED',
    );
  }
  if (visit.feedback.rating < 1 || visit.feedback.rating > 5) {
    throw new SiteVisitDomainError(
      'Feedback rating must be an integer between 1 and 5',
      'INVALID_FEEDBACK_RATING',
    );
  }
}
