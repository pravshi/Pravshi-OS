/**
 * Education Contracts — Public Domain Events.
 *
 * Emitted across the domain events port for workflow orchestration, audit logging,
 * and outbound notifications. Tenant-stamped by authorization context.
 */

export interface ApplicationSubmittedEvent {
  readonly type: 'education.application.submitted';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly applicantId: string;
    readonly programId: string;
    readonly batchIntakeId: string;
    readonly applicantName: string;
    readonly email: string;
  };
}

export interface StudentEnrolledEvent {
  readonly type: 'education.student.enrolled';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly studentId: string;
    readonly studentNumber: string;
    readonly programId: string;
    readonly batchIntakeId: string;
    readonly enrolledAt: string;
  };
}

export type EducationEvent = ApplicationSubmittedEvent | StudentEnrolledEvent;
