/**
 * Education Domain — Programs, Courses, Batches/Intakes, Academic Years.
 *
 * Implements pure business logic, invariants, and structures for academic curriculum
 * and intake capacity management under Pravshi OS Blueprint §06.
 */

export const DEGREE_LEVELS = [
  'certificate',
  'diploma',
  'undergraduate',
  'postgraduate',
  'doctorate',
  'executive',
] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];

export const BATCH_STATUSES = [
  'upcoming',
  'open',
  'admissions_closed',
  'in_session',
  'completed',
  'cancelled',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export interface AcademicYear {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string; // e.g. "2026-2027"
  readonly startDate: Date;
  readonly endDate: Date;
  readonly isCurrent: boolean;
}

export interface AcademicCourse {
  readonly id: string;
  readonly programId: string;
  readonly courseCode: string;
  readonly title: string;
  readonly description?: string;
  readonly credits: number;
  readonly syllabusUrl?: string;
  readonly isElective: boolean;
}

export interface AcademicProgram {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly degreeLevel: DegreeLevel;
  readonly department: string;
  readonly durationMonths: number;
  readonly totalCredits: number;
  readonly tuitionFee: number;
  readonly currency: string;
  readonly isActive: boolean;
  readonly courses: readonly AcademicCourse[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BatchIntake {
  readonly id: string;
  readonly organizationId: string;
  readonly programId: string;
  readonly academicYearId: string;
  readonly name: string; // e.g. "Fall 2026"
  readonly maxCapacity: number;
  readonly enrolledCount: number;
  readonly applicationDeadline: Date;
  readonly termStartDate: Date;
  readonly status: BatchStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ProgramDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ProgramDomainError';
  }
}

/**
 * Invariant: Batch capacity validation.
 * Maximum capacity must be strictly positive, enrolled count cannot exceed maxCapacity.
 */
export function validateBatchCapacity(intake: BatchIntake): void {
  if (intake.maxCapacity <= 0) {
    throw new ProgramDomainError(
      'Batch maximum capacity must be greater than zero',
      'INVALID_CAPACITY',
    );
  }
  if (intake.enrolledCount > intake.maxCapacity) {
    throw new ProgramDomainError(
      `Enrolled count (${intake.enrolledCount}) exceeds max capacity (${intake.maxCapacity})`,
      'BATCH_OVER_CAPACITY',
    );
  }
}

/**
 * Invariant: Batch must be open for admissions and application deadline not passed.
 */
export function assertBatchOpenForAdmissions(
  intake: BatchIntake,
  referenceDate: Date = new Date(),
): void {
  if (intake.status !== 'open') {
    throw new ProgramDomainError(
      `Batch intake is not open for admissions (current: ${intake.status})`,
      'BATCH_NOT_OPEN',
    );
  }
  if (referenceDate > intake.applicationDeadline) {
    throw new ProgramDomainError(
      'Application deadline for this batch has passed',
      'DEADLINE_PASSED',
    );
  }
  if (intake.enrolledCount >= intake.maxCapacity) {
    throw new ProgramDomainError('Batch has reached maximum enrollment capacity', 'BATCH_FULL');
  }
}
