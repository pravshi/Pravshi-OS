/**
 * Education Domain — Admissions Pipeline Invariants.
 *
 * Enforces discrete state machine progression for university/institute admissions,
 * preventing offer extension without documentation or enrollment without fee clearance.
 */

import { APPLICANT_STAGES, type ApplicantStage } from './applicant';

export class AdmissionsPipelineDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AdmissionsPipelineDomainError';
  }
}

/**
 * Validates transition from current stage to next stage in admissions pipeline.
 */
export function validateAdmissionsStageTransition(
  currentStage: ApplicantStage,
  nextStage: ApplicantStage,
): void {
  if (currentStage === nextStage) return;

  if (currentStage === 'rejected' || currentStage === 'withdrawn') {
    throw new AdmissionsPipelineDomainError(
      `Cannot transition out of terminal stage ${currentStage}`,
      'TERMINAL_STAGE_IMMUTABLE',
    );
  }

  // Can withdraw or be rejected at any point before matriculation
  if (nextStage === 'rejected' || nextStage === 'withdrawn') return;

  const currentIndex = APPLICANT_STAGES.indexOf(currentStage);
  const nextIndex = APPLICANT_STAGES.indexOf(nextStage);

  if (currentIndex === -1 || nextIndex === -1) {
    throw new AdmissionsPipelineDomainError(
      `Unknown admissions stage: ${currentStage} -> ${nextStage}`,
      'UNKNOWN_STAGE',
    );
  }

  // Rule: Cannot extend offer before application submitted and documents verified
  if (
    nextStage === 'offer_extended' &&
    currentIndex < APPLICANT_STAGES.indexOf('documents_verified')
  ) {
    throw new AdmissionsPipelineDomainError(
      'Cannot extend offer before application is submitted and mandatory documents are verified',
      'DOCUMENTS_UNVERIFIED_FOR_OFFER',
    );
  }

  // Rule: Cannot accept offer if offer was not extended
  if (nextStage === 'offer_accepted' && currentStage !== 'offer_extended') {
    throw new AdmissionsPipelineDomainError(
      'Cannot accept offer when offer has not been extended',
      'NO_ACTIVE_OFFER',
    );
  }

  // Rule: Cannot transition to fee_paid without accepted offer
  if (nextStage === 'fee_paid' && currentStage !== 'offer_accepted') {
    throw new AdmissionsPipelineDomainError(
      'Cannot mark fee paid before offer is accepted',
      'OFFER_NOT_ACCEPTED',
    );
  }
}
