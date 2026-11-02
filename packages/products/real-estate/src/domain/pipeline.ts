/**
 * Real Estate Domain — Sales vs Rental Pipeline Invariants.
 *
 * Enforces discrete state machine progression and legal/transaction compliance
 * differences between property sales and residential/commercial leasing.
 */

import { RealEstateDealStage } from './deal';

export const SALES_PIPELINE_STAGES: readonly RealEstateDealStage[] = [
  'inquiry',
  'site_visit_scheduled',
  'site_visit_completed',
  'token_received',
  'documentation',
  'loan_processing',
  'registration_scheduled',
  'closed_won',
  'closed_lost',
];

export const RENTAL_PIPELINE_STAGES = [
  'inquiry',
  'site_visit_scheduled',
  'site_visit_completed',
  'tenant_screening',
  'security_deposit',
  'lease_drafting',
  'lease_signed',
  'closed_won',
  'closed_lost',
] as const;
export type RentalPipelineStage = (typeof RENTAL_PIPELINE_STAGES)[number];

export class PipelineDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PipelineDomainError';
  }
}

/**
 * Invariant: Validates stage transitions for Sales pipelines.
 */
export function validateSalesStageTransition(
  currentStage: RealEstateDealStage,
  nextStage: RealEstateDealStage,
): void {
  if (currentStage === nextStage) return;
  if (currentStage === 'closed_won' || currentStage === 'closed_lost') {
    throw new PipelineDomainError(
      `Cannot transition out of terminal stage ${currentStage}`,
      'TERMINAL_STAGE_IMMUTABLE',
    );
  }
  if (nextStage === 'closed_lost') return; // Can abort at any stage

  const currentIndex = SALES_PIPELINE_STAGES.indexOf(currentStage);
  const nextIndex = SALES_PIPELINE_STAGES.indexOf(nextStage);

  if (currentIndex === -1 || nextIndex === -1) {
    throw new PipelineDomainError(
      `Unknown stage: ${currentStage} -> ${nextStage}`,
      'UNKNOWN_STAGE',
    );
  }

  // Prevent jumping straight to closing without token
  if (
    nextStage === 'closed_won' &&
    currentIndex < SALES_PIPELINE_STAGES.indexOf('token_received')
  ) {
    throw new PipelineDomainError(
      'Cannot close won before token receipt and documentation in sales pipeline',
      'ILLEGAL_STAGE_BYPASS',
    );
  }
}

/**
 * Invariant: Validates stage transitions for Rental pipelines.
 */
export function validateRentalStageTransition(
  currentStage: RentalPipelineStage,
  nextStage: RentalPipelineStage,
): void {
  if (currentStage === nextStage) return;
  if (currentStage === 'closed_won' || currentStage === 'closed_lost') {
    throw new PipelineDomainError(
      `Cannot transition out of terminal rental stage ${currentStage}`,
      'TERMINAL_STAGE_IMMUTABLE',
    );
  }
  if (nextStage === 'closed_lost') return;

  const currentIndex = RENTAL_PIPELINE_STAGES.indexOf(currentStage);
  const nextIndex = RENTAL_PIPELINE_STAGES.indexOf(nextStage);

  if (currentIndex === -1 || nextIndex === -1) {
    throw new PipelineDomainError(
      `Unknown rental stage: ${currentStage} -> ${nextStage}`,
      'UNKNOWN_STAGE',
    );
  }

  // Tenant screening and security deposit required before lease execution
  if (
    nextStage === 'lease_signed' &&
    currentIndex < RENTAL_PIPELINE_STAGES.indexOf('security_deposit')
  ) {
    throw new PipelineDomainError(
      'Cannot execute lease without tenant screening and security deposit confirmation',
      'ILLEGAL_RENTAL_STAGE_BYPASS',
    );
  }
}
