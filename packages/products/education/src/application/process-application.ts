/**
 * Application Use Case — Process Application Stage & Document Verification.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import { type Applicant, assertAllMandatoryDocumentsVerified } from '../domain/applicant';
import { validateAdmissionsStageTransition } from '../domain/admissions-pipeline';
import type { ProcessApplicationInput } from '../api/schemas';
import type { ApplicantRepository } from '../data-access/repository';

export interface ProcessApplicationDependencies {
  readonly applicantRepository: ApplicantRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function processApplication(
  auth: Authorization,
  applicantId: string,
  input: ProcessApplicationInput,
  deps: ProcessApplicationDependencies,
  tx?: Tx,
): Promise<Applicant> {
  const applicant = await deps.applicantRepository.findById(auth, applicantId, tx);
  if (!applicant) {
    throw new Error(`Applicant not found: ${applicantId}`);
  }

  // Validate state machine rules
  validateAdmissionsStageTransition(applicant.stage, input.targetStage);

  // If extending an offer, verify mandatory documents
  if (input.targetStage === 'offer_extended') {
    assertAllMandatoryDocumentsVerified(applicant.documents);
  }

  const updated = await deps.applicantRepository.update(
    auth,
    applicantId,
    {
      stage: input.targetStage,
      offerLetterUrl: input.offerLetterUrl ?? applicant.offerLetterUrl,
      offerExtendedAt:
        input.targetStage === 'offer_extended' ? new Date() : applicant.offerExtendedAt,
      offerAcceptedAt:
        input.targetStage === 'offer_accepted' ? new Date() : applicant.offerAcceptedAt,
      rejectionReason: input.rejectionReason ?? applicant.rejectionReason,
    },
    tx,
  );

  if (input.targetStage === 'application_submitted' && deps.emitEvent) {
    await deps.emitEvent({
      type: 'education.application.submitted',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: new Date().toISOString(),
      payload: {
        applicantId: updated.id,
        programId: updated.programId,
        batchIntakeId: updated.batchIntakeId,
        applicantName: `${updated.firstName} ${updated.lastName}`,
        email: updated.email,
      },
    });
  }

  return updated;
}
