/**
 * Application Use Case — Schedule & Complete Site Visit.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import {
  type SiteVisit,
  validateSiteVisitTimeWindow,
  assertCanCompleteSiteVisit,
} from '../domain/site-visit';
import type { ScheduleSiteVisitInput, RecordSiteVisitFeedbackInput } from '../api/schemas';
import type { SiteVisitRepository } from '../data-access/repository';

export interface SiteVisitDependencies {
  readonly siteVisitRepository: SiteVisitRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function scheduleSiteVisit(
  auth: Authorization,
  input: ScheduleSiteVisitInput,
  deps: SiteVisitDependencies,
  tx?: Tx,
): Promise<SiteVisit> {
  validateSiteVisitTimeWindow(input.scheduledStartTime, input.scheduledEndTime);

  const candidate: Omit<SiteVisit, 'createdAt' | 'updatedAt'> = {
    id: crypto.randomUUID(),
    organizationId: auth.ctx.orgId,
    listingId: input.listingId,
    unitId: input.unitId,
    leadOrContactId: input.leadOrContactId,
    agentId: input.agentId,
    scheduledStartTime: input.scheduledStartTime,
    scheduledEndTime: input.scheduledEndTime,
    status: 'confirmed',
  };

  return await deps.siteVisitRepository.create(auth, candidate, tx);
}

export async function completeSiteVisit(
  auth: Authorization,
  visitId: string,
  feedbackInput: RecordSiteVisitFeedbackInput,
  deps: SiteVisitDependencies,
  tx?: Tx,
): Promise<SiteVisit> {
  const visit = await deps.siteVisitRepository.findById(auth, visitId, tx);
  if (!visit) {
    throw new Error(`Site visit not found: ${visitId}`);
  }

  const updatedCandidate: SiteVisit = {
    ...visit,
    status: 'completed',
    verifiedAt: new Date(),
    verificationMethod: feedbackInput.verificationMethod,
    feedback: {
      rating: feedbackInput.rating,
      interestLevel: feedbackInput.interestLevel,
      notes: feedbackInput.notes,
      followUpAction: feedbackInput.followUpAction,
      followUpDate: feedbackInput.followUpDate,
    },
  };

  assertCanCompleteSiteVisit(updatedCandidate);

  const updated = await deps.siteVisitRepository.update(
    auth,
    visitId,
    {
      status: 'completed',
      verifiedAt: updatedCandidate.verifiedAt,
      verificationMethod: updatedCandidate.verificationMethod,
      feedback: updatedCandidate.feedback,
    },
    tx,
  );

  if (deps.emitEvent && updated.feedback && updated.verifiedAt) {
    await deps.emitEvent({
      type: 'real_estate.site_visit.completed',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: new Date().toISOString(),
      payload: {
        siteVisitId: updated.id,
        listingId: updated.listingId,
        leadOrContactId: updated.leadOrContactId,
        agentId: updated.agentId,
        rating: updated.feedback.rating,
        interestLevel: updated.feedback.interestLevel,
        verifiedAt: updated.verifiedAt.toISOString(),
      },
    });
  }

  return updated;
}
