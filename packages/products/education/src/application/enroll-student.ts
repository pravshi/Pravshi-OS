/**
 * Application Use Case — Enroll Student.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import { type Student, type FeeSchedule, assertCanEnrollStudent } from '../domain/student';
import { validateBatchCapacity } from '../domain/program';
import type { EnrollStudentInput } from '../api/schemas';
import type {
  ApplicantRepository,
  AcademicProgramRepository,
  StudentRepository,
} from '../data-access/repository';

export interface EnrollStudentDependencies {
  readonly applicantRepository: ApplicantRepository;
  readonly programRepository: AcademicProgramRepository;
  readonly studentRepository: StudentRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function enrollStudent(
  auth: Authorization,
  input: EnrollStudentInput,
  deps: EnrollStudentDependencies,
  tx?: Tx,
): Promise<Student> {
  const applicant = await deps.applicantRepository.findById(auth, input.applicantId, tx);
  if (!applicant) {
    throw new Error(`Applicant not found: ${input.applicantId}`);
  }

  if (applicant.stage !== 'offer_accepted' && applicant.stage !== 'fee_paid') {
    throw new Error(
      `Cannot enroll applicant in stage ${applicant.stage}. Offer must be accepted first.`,
    );
  }

  const batch = await deps.programRepository.getBatchIntake(auth, applicant.batchIntakeId, tx);
  if (!batch) {
    throw new Error(`Batch intake not found: ${applicant.batchIntakeId}`);
  }

  validateBatchCapacity(batch);

  const program = await deps.programRepository.findById(auth, applicant.programId, tx);
  if (!program) {
    throw new Error(`Program not found: ${applicant.programId}`);
  }

  const feeSchedule: FeeSchedule = {
    id: crypto.randomUUID(),
    studentId: '', // populated below
    batchIntakeId: batch.id,
    totalFee: program.tuitionFee,
    currency: program.currency,
    installments: [
      {
        id: crypto.randomUUID(),
        installmentNumber: 1,
        amount: program.tuitionFee / 2,
        dueDate: new Date(),
        paidAmount: input.firstInstallmentPaidAmount,
        status: input.firstInstallmentPaidAmount >= program.tuitionFee / 2 ? 'paid' : 'partial',
        paidAt: new Date(),
        transactionReference: input.paymentReference,
      },
    ],
  };

  assertCanEnrollStudent(feeSchedule);

  const studentId = crypto.randomUUID();
  const studentNumber = input.studentNumber ?? `STU-${Date.now().toString().slice(-6)}`;

  const studentCandidate: Omit<Student, 'createdAt' | 'updatedAt'> = {
    id: studentId,
    organizationId: auth.ctx.orgId,
    studentNumber,
    applicantId: applicant.id,
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    email: applicant.email,
    phone: applicant.phone,
    dateOfBirth: input.dateOfBirth,
    status: 'active',
    enrollments: [
      {
        id: crypto.randomUUID(),
        studentId,
        programId: program.id,
        batchIntakeId: batch.id,
        enrolledAt: new Date(),
        status: 'enrolled',
      },
    ],
    feeSchedule: {
      ...feeSchedule,
      studentId,
    },
  };

  const createdStudent = await deps.studentRepository.create(auth, studentCandidate, tx);

  // Advance applicant stage
  await deps.applicantRepository.update(auth, applicant.id, { stage: 'fee_paid' }, tx);

  // Increment batch enrolled count
  await deps.programRepository.updateBatchIntake(
    auth,
    batch.id,
    { enrolledCount: batch.enrolledCount + 1 },
    tx,
  );

  if (deps.emitEvent) {
    await deps.emitEvent({
      type: 'education.student.enrolled',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: new Date().toISOString(),
      payload: {
        studentId: createdStudent.id,
        studentNumber: createdStudent.studentNumber,
        programId: program.id,
        batchIntakeId: batch.id,
        enrolledAt: new Date().toISOString(),
      },
    });
  }

  return createdStudent;
}
