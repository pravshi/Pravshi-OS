/**
 * Education API — Zod Validation Schemas and Route Contracts.
 */

import { z } from 'zod';
import { DEGREE_LEVELS } from '../domain/program';
import {
  APPLICANT_STAGES,
  DOCUMENT_TYPES,
  DOCUMENT_VERIFICATION_STATUSES,
} from '../domain/applicant';

export const CreateCourseSchema = z.object({
  courseCode: z.string().min(2).max(20),
  title: z.string().min(3).max(200),
  description: z.string().optional(),
  credits: z.number().int().positive(),
  syllabusUrl: z.string().url().optional(),
  isElective: z.boolean().default(false),
});

export const CreateProgramSchema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(3).max(200),
  degreeLevel: z.enum(DEGREE_LEVELS),
  department: z.string().min(2),
  durationMonths: z.number().int().positive(),
  totalCredits: z.number().int().positive(),
  tuitionFee: z.number().nonnegative(),
  currency: z.string().length(3).default('INR'),
  courses: z.array(CreateCourseSchema).default([]),
});

export type CreateProgramInput = z.infer<typeof CreateProgramSchema>;

export const CreateBatchIntakeSchema = z.object({
  programId: z.string().uuid(),
  academicYearId: z.string().uuid(),
  name: z.string().min(2),
  maxCapacity: z.number().int().positive(),
  applicationDeadline: z.coerce.date(),
  termStartDate: z.coerce.date(),
});

export type CreateBatchIntakeInput = z.infer<typeof CreateBatchIntakeSchema>;

export const RegisterApplicantSchema = z.object({
  programId: z.string().uuid(),
  batchIntakeId: z.string().uuid(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().min(5).max(20),
});

export type RegisterApplicantInput = z.infer<typeof RegisterApplicantSchema>;

export const UploadDocumentSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES),
  title: z.string().min(1),
  fileUrl: z.string().url(),
});

export const VerifyDocumentSchema = z.object({
  documentId: z.string().uuid(),
  status: z.enum(DOCUMENT_VERIFICATION_STATUSES),
  rejectionReason: z.string().optional(),
});

export const RecordCounsellingSchema = z.object({
  counsellorId: z.string().uuid(),
  scheduledAt: z.coerce.date(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
  notes: z.string().optional(),
  recommendation: z.enum(['admit', 'reject', 'conditional_admit', 'follow_up_needed']).optional(),
});

export const ProcessApplicationSchema = z.object({
  targetStage: z.enum(APPLICANT_STAGES),
  offerLetterUrl: z.string().url().optional(),
  rejectionReason: z.string().optional(),
});

export type ProcessApplicationInput = z.infer<typeof ProcessApplicationSchema>;

export const EnrollStudentSchema = z.object({
  applicantId: z.string().uuid(),
  studentNumber: z.string().min(3).max(50).optional(),
  dateOfBirth: z.coerce.date(),
  firstInstallmentPaidAmount: z.number().positive(),
  paymentReference: z.string().min(1),
});

export type EnrollStudentInput = z.infer<typeof EnrollStudentSchema>;
