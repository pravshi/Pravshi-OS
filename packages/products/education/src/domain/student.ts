/**
 * Education Domain — Students, Enrollments, Attendance, Fees.
 *
 * Implements matriculation, academic course enrollment, attendance tracking, and fee schedules.
 */

export const STUDENT_STATUSES = [
  'active',
  'probation',
  'suspended',
  'graduated',
  'withdrawn',
] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const ENROLLMENT_STATUSES = ['enrolled', 'deferred', 'completed', 'dropped'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['present', 'absent', 'excused', 'late'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const FEE_INSTALLMENT_STATUSES = ['unpaid', 'partial', 'paid', 'overdue'] as const;
export type FeeInstallmentStatus = (typeof FEE_INSTALLMENT_STATUSES)[number];

export interface AttendanceRecord {
  readonly id: string;
  readonly studentId: string;
  readonly courseId: string;
  readonly sessionDate: Date;
  readonly status: AttendanceStatus;
  readonly remarks?: string;
}

export interface FeeInstallment {
  readonly id: string;
  readonly installmentNumber: number;
  readonly amount: number;
  readonly dueDate: Date;
  readonly paidAmount: number;
  readonly status: FeeInstallmentStatus;
  readonly paidAt?: Date;
  readonly transactionReference?: string;
}

export interface FeeSchedule {
  readonly id: string;
  readonly studentId: string;
  readonly batchIntakeId: string;
  readonly totalFee: number;
  readonly currency: string;
  readonly installments: readonly FeeInstallment[];
}

export interface StudentEnrollment {
  readonly id: string;
  readonly studentId: string;
  readonly programId: string;
  readonly batchIntakeId: string;
  readonly enrolledAt: Date;
  readonly status: EnrollmentStatus;
}

export interface Student {
  readonly id: string;
  readonly organizationId: string;
  readonly studentNumber: string; // e.g. "STU-2026-0042"
  readonly applicantId?: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  readonly dateOfBirth: Date;
  readonly status: StudentStatus;
  readonly enrollments: readonly StudentEnrollment[];
  readonly feeSchedule?: FeeSchedule;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class StudentDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'StudentDomainError';
  }
}

/**
 * Calculates student attendance percentage for a course or overall.
 */
export function calculateAttendancePercentage(records: readonly AttendanceRecord[]): number {
  if (records.length === 0) return 100;
  let attended = 0;
  for (const r of records) {
    if (r.status === 'present' || r.status === 'late') {
      attended += 1;
    }
  }
  return Math.round((attended / records.length) * 100);
}

/**
 * Invariant: Check that student is eligible to enroll.
 * Fee must be confirmed paid or partial for first installment.
 */
export function assertCanEnrollStudent(schedule?: FeeSchedule): void {
  if (!schedule || schedule.installments.length === 0) {
    throw new StudentDomainError(
      'Fee schedule must be generated before enrollment',
      'FEE_SCHEDULE_REQUIRED',
    );
  }
  const firstInstallment = schedule.installments[0];
  if (
    !firstInstallment ||
    (firstInstallment.status !== 'paid' && firstInstallment.paidAmount <= 0)
  ) {
    throw new StudentDomainError(
      'Initial fee payment is required before completing enrollment',
      'INITIAL_FEE_REQUIRED',
    );
  }
}
