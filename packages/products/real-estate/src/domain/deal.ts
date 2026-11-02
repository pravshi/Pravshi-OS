/**
 * Real Estate Domain — Deals, Broker Commission Splits, Booking Tokens.
 *
 * Implements high-value transaction rules, financial token safeguards, and multi-party broker splits.
 */

export const REAL_ESTATE_DEAL_STAGES = [
  'inquiry',
  'site_visit_scheduled',
  'site_visit_completed',
  'token_received',
  'documentation',
  'loan_processing',
  'registration_scheduled',
  'closed_won',
  'closed_lost',
] as const;
export type RealEstateDealStage = (typeof REAL_ESTATE_DEAL_STAGES)[number];

export const TOKEN_STATUSES = ['received', 'cleared', 'forfeited', 'refunded'] as const;
export type BookingTokenStatus = (typeof TOKEN_STATUSES)[number];

export const BROKER_ROLES = [
  'listing_agent',
  'selling_agent',
  'external_broker',
  'referral_partner',
] as const;
export type BrokerRole = (typeof BROKER_ROLES)[number];

export const COMMISSION_PAYOUT_STATUSES = [
  'pending',
  'approved',
  'disbursed',
  'cancelled',
] as const;
export type CommissionPayoutStatus = (typeof COMMISSION_PAYOUT_STATUSES)[number];

export interface BookingToken {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethod: 'bank_transfer' | 'cheque' | 'card' | 'upi' | 'escrow';
  readonly paymentReference: string;
  readonly receivedAt: Date;
  readonly expiresAt?: Date;
  readonly refundable: boolean;
  readonly status: BookingTokenStatus;
  readonly refundTerms?: string;
}

export interface CommissionSplit {
  readonly recipientId: string;
  readonly recipientName: string;
  readonly role: BrokerRole;
  readonly percentage: number; // e.g. 50% for 50
  readonly fixedAmount?: number;
  readonly payoutStatus: CommissionPayoutStatus;
}

export interface RealEstateDeal {
  readonly id: string;
  readonly organizationId: string;
  readonly listingId: string;
  readonly unitId?: string;
  readonly contactId: string;
  readonly stage: RealEstateDealStage;
  readonly agreedPrice: number;
  readonly currency: string;
  readonly bookingToken?: BookingToken;
  readonly commissionSplits: readonly CommissionSplit[];
  readonly expectedClosingDate?: Date;
  readonly actualClosedDate?: Date;
  readonly lostReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class DealDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DealDomainError';
  }
}

/**
 * Invariant: Commission splits must not exceed 100% and individual percentages must be >= 0.
 */
export function validateCommissionSplits(splits: readonly CommissionSplit[]): void {
  let totalPercent = 0;
  for (const split of splits) {
    if (split.percentage < 0 || split.percentage > 100) {
      throw new DealDomainError(
        `Invalid split percentage: ${split.percentage}`,
        'INVALID_SPLIT_PERCENTAGE',
      );
    }
    totalPercent += split.percentage;
  }
  if (totalPercent > 100) {
    throw new DealDomainError(
      `Total commission split percentage cannot exceed 100%, got ${totalPercent}%`,
      'COMMISSION_EXCEEDS_100_PERCENT',
    );
  }
}

/**
 * Invariant: Booking token rules. Cleared booking token required before contract/loan/registration stage.
 */
export function assertValidBookingToken(token: BookingToken): void {
  if (token.amount <= 0) {
    throw new DealDomainError(
      'Booking token amount must be greater than zero',
      'INVALID_TOKEN_AMOUNT',
    );
  }
  if (!token.paymentReference || token.paymentReference.trim().length === 0) {
    throw new DealDomainError(
      'Payment reference is required for booking token',
      'MISSING_PAYMENT_REFERENCE',
    );
  }
}

/**
 * Invariant: Deal cannot be closed won without cleared token, agreed price, and non-empty commission allocation.
 */
export function assertCanCloseWonRealEstateDeal(deal: RealEstateDeal): void {
  if (deal.stage === 'closed_lost') {
    throw new DealDomainError('Cannot close-won a deal that is marked lost', 'DEAL_ALREADY_LOST');
  }
  if (deal.agreedPrice <= 0) {
    throw new DealDomainError(
      'Agreed transaction price must be greater than zero',
      'INVALID_AGREED_PRICE',
    );
  }
  if (!deal.bookingToken || deal.bookingToken.status !== 'cleared') {
    throw new DealDomainError(
      'A cleared booking token is required to close-won a deal',
      'CLEARED_TOKEN_REQUIRED',
    );
  }
  validateCommissionSplits(deal.commissionSplits);
}
