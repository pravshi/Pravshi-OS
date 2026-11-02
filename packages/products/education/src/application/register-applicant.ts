/**
 * Application Use Case — Register Applicant.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import { type Applicant } from '../domain/applicant';
import { assertBatchOpenForAdmissions } from '../domain/program';
import type { RegisterApplicantInput } from '../api/schemas';
import type { ApplicantRepository, AcademicProgramRepository } from '../data-access/repository';

export interface RegisterApplicantDependencies {
  readonly applicantRepository: ApplicantRepository;
  readonly programRepository: AcademicProgramRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function registerApplicant(
  auth: Authorization,
  input: RegisterApplicantInput,
  deps: RegisterApplicantDependencies,
  tx?: Tx,
): Promise<Applicant> {
  const batch = await deps.programRepository.getBatchIntake(auth, input.batchIntakeId, tx);
  if (!batch) {
    throw new Error(`Batch intake not found: ${input.batchIntakeId}`);
  }

  assertBatchOpenForAdmissions(batch);

  const existing = await deps.applicantRepository.findByEmail(
    auth,
    input.email,
    input.batchIntakeId,
    tx,
  );
  if (existing) {
    throw new Error(
      `An application with email ${input.email} already exists for this intake batch`,
    );
  }

  const candidate: Omit<Applicant, 'createdAt' | 'updatedAt'> = {
    id: crypto.randomUUID(),
    organizationId: auth.ctx.orgId,
    programId: input.programId,
    batchIntakeId: input.batchIntakeId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    stage: 'enquiry',
    counsellingSessions: [],
    documents: [],
  };

  return await deps.applicantRepository.create(auth, candidate, tx);
}
