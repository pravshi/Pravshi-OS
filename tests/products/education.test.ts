import { describe, expect, it } from 'vitest';
import {
  assertBatchOpenForAdmissions,
  validateBatchCapacity,
  type BatchIntake,
} from '@pravshi/product-education';
import { validateAdmissionsStageTransition } from '@pravshi/product-education';
import { assertCanEnrollStudent, type FeeSchedule } from '@pravshi/product-education';
import { CreateCourseSchema, RegisterApplicantSchema } from '@pravshi/product-education';

describe('Education Vertical: Domain Rules & Invariants', () => {
  it('validates batch capacity invariants', () => {
    const validBatch: BatchIntake = {
      id: 'b-1',
      organizationId: 'org-1',
      programId: 'prog-1',
      academicYearId: 'ay-1',
      name: 'Batch A',
      maxCapacity: 50,
      enrolledCount: 20,
      applicationDeadline: new Date(Date.now() + 86400000),
      termStartDate: new Date(Date.now() + 86400000 * 30),
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(() => validateBatchCapacity(validBatch)).not.toThrow();

    expect(() =>
      validateBatchCapacity({
        ...validBatch,
        enrolledCount: 55,
      }),
    ).toThrow(/exceeds max capacity/i);
  });

  it('validates batch admissions status', () => {
    const batch: BatchIntake = {
      id: 'b-1',
      organizationId: 'org-1',
      programId: 'prog-1',
      academicYearId: 'ay-1',
      name: 'Batch B',
      maxCapacity: 60,
      enrolledCount: 10,
      applicationDeadline: new Date(Date.now() + 86400000),
      termStartDate: new Date(Date.now() + 86400000 * 30),
      status: 'upcoming',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(() => assertBatchOpenForAdmissions(batch)).toThrow(/not open for admissions/i);
  });

  it('validates admissions pipeline stage progression', () => {
    expect(() =>
      validateAdmissionsStageTransition('enquiry', 'counselling_scheduled'),
    ).not.toThrow();
    expect(() => validateAdmissionsStageTransition('enquiry', 'offer_extended')).toThrow(
      /cannot extend offer/i,
    );
  });

  it('enforces student enrollment preconditions', () => {
    expect(() => assertCanEnrollStudent(undefined)).toThrow(/fee schedule must be generated/i);

    const unpaidSchedule: FeeSchedule = {
      id: 'fs-1',
      studentId: 's-1',
      batchIntakeId: 'b-1',
      totalFee: 100000,
      currency: 'INR',
      installments: [
        {
          id: 'inst-1',
          installmentNumber: 1,
          amount: 50000,
          dueDate: new Date(),
          paidAmount: 0,
          status: 'unpaid',
        },
      ],
    };

    expect(() => assertCanEnrollStudent(unpaidSchedule)).toThrow(
      /initial fee payment is required/i,
    );

    const paidSchedule: FeeSchedule = {
      ...unpaidSchedule,
      installments: [
        {
          id: 'inst-1',
          installmentNumber: 1,
          amount: 50000,
          dueDate: new Date(),
          paidAmount: 50000,
          status: 'paid',
        },
      ],
    };
    expect(() => assertCanEnrollStudent(paidSchedule)).not.toThrow();
  });

  it('validates API schemas for courses and applicants', () => {
    const validCourse = CreateCourseSchema.safeParse({
      courseCode: 'CS101',
      title: 'Introduction to Computer Science',
      credits: 4,
    });
    expect(validCourse.success).toBe(true);

    const validApplicant = RegisterApplicantSchema.safeParse({
      programId: '123e4567-e89b-12d3-a456-426614174000',
      batchIntakeId: '123e4567-e89b-12d3-a456-426614174001',
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      phone: '+919876543210',
    });
    expect(validApplicant.success).toBe(true);
  });
});
