/**
 * Application Use Case — Manage Real Estate Deal Lifecycle.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import {
  type RealEstateDeal,
  type BookingToken,
  assertCanCloseWonRealEstateDeal,
  assertValidBookingToken,
  validateCommissionSplits,
} from '../domain/deal';
import { validateSalesStageTransition } from '../domain/pipeline';
import type { ManageDealInput } from '../api/schemas';
import type { RealEstateDealRepository } from '../data-access/repository';

export interface DealDependencies {
  readonly dealRepository: RealEstateDealRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function updateDealStage(
  auth: Authorization,
  dealId: string,
  input: ManageDealInput,
  deps: DealDependencies,
  tx?: Tx,
): Promise<RealEstateDeal> {
  const deal = await deps.dealRepository.findById(auth, dealId, tx);
  if (!deal) {
    throw new Error(`Real estate deal not found: ${dealId}`);
  }

  // Validate state machine rules
  validateSalesStageTransition(deal.stage, input.stage);

  let updatedToken: BookingToken | undefined = deal.bookingToken;
  if (input.bookingToken) {
    const candidateToken: BookingToken = {
      id: crypto.randomUUID(),
      amount: input.bookingToken.amount,
      currency: input.bookingToken.currency,
      paymentMethod: input.bookingToken.paymentMethod,
      paymentReference: input.bookingToken.paymentReference,
      receivedAt: new Date(),
      expiresAt: input.bookingToken.expiresAt,
      refundable: input.bookingToken.refundable,
      status: 'cleared',
      refundTerms: input.bookingToken.refundTerms,
    };
    assertValidBookingToken(candidateToken);
    updatedToken = candidateToken;
  }

  let splits = deal.commissionSplits;
  if (input.commissionSplits) {
    const formattedSplits = input.commissionSplits.map((s) => ({
      recipientId: s.recipientId,
      recipientName: s.recipientName,
      role: s.role,
      percentage: s.percentage,
      fixedAmount: s.fixedAmount,
      payoutStatus: 'pending' as const,
    }));
    validateCommissionSplits(formattedSplits);
    splits = formattedSplits;
  }

  const updatedDeal: RealEstateDeal = {
    ...deal,
    stage: input.stage,
    agreedPrice: input.agreedPrice ?? deal.agreedPrice,
    bookingToken: updatedToken,
    commissionSplits: splits,
    lostReason: input.lostReason ?? deal.lostReason,
    actualClosedDate: input.stage === 'closed_won' ? new Date() : deal.actualClosedDate,
  };

  if (input.stage === 'closed_won') {
    assertCanCloseWonRealEstateDeal(updatedDeal);
  }

  const saved = await deps.dealRepository.update(
    auth,
    dealId,
    {
      stage: updatedDeal.stage,
      agreedPrice: updatedDeal.agreedPrice,
      bookingToken: updatedDeal.bookingToken,
      commissionSplits: updatedDeal.commissionSplits,
      lostReason: updatedDeal.lostReason,
      actualClosedDate: updatedDeal.actualClosedDate,
    },
    tx,
  );

  if (input.stage === 'closed_won' && deps.emitEvent) {
    const totalSplits = saved.commissionSplits.reduce(
      (acc, curr) => acc + (curr.fixedAmount ?? (saved.agreedPrice * curr.percentage) / 100),
      0,
    );
    await deps.emitEvent({
      type: 'real_estate.deal.closed_won',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: new Date().toISOString(),
      payload: {
        dealId: saved.id,
        listingId: saved.listingId,
        contactId: saved.contactId,
        agreedPrice: saved.agreedPrice,
        currency: saved.currency,
        totalCommissionDistributed: totalSplits,
        bookingTokenId: saved.bookingToken?.id,
      },
    });
  }

  return saved;
}
