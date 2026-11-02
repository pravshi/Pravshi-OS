/**
 * Education Data Access — Tenant-scoped Repository Contracts.
 *
 * Implements data access signatures for academic programs, batches, applicants, and students.
 * Bound to tenant authorization context with fail-closed RLS.
 */

import type { Tx } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import type { AcademicProgram, BatchIntake } from '../domain/program';
import type { Applicant, ApplicantStage } from '../domain/applicant';
import type { Student, StudentStatus } from '../domain/student';

export interface ApplicantFilter {
  readonly programId?: string;
  readonly batchIntakeId?: string;
  readonly stage?: ApplicantStage;
  readonly limit?: number;
  readonly offset?: number;
}

export interface StudentFilter {
  readonly programId?: string;
  readonly batchIntakeId?: string;
  readonly status?: StudentStatus;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AcademicProgramRepository {
  findById(auth: Authorization, id: string, tx?: Tx): Promise<AcademicProgram | null>;
  list(auth: Authorization, tx?: Tx): Promise<readonly AcademicProgram[]>;
  create(
    auth: Authorization,
    program: Omit<AcademicProgram, 'createdAt' | 'updatedAt'>,
    tx?: Tx,
  ): Promise<AcademicProgram>;
  update(
    auth: Authorization,
    id: string,
    patch: Partial<AcademicProgram>,
    tx?: Tx,
  ): Promise<AcademicProgram>;
  getBatchIntake(auth: Authorization, id: string, tx?: Tx): Promise<BatchIntake | null>;
  updateBatchIntake(
    auth: Authorization,
    id: string,
    patch: Partial<BatchIntake>,
    tx?: Tx,
  ): Promise<BatchIntake>;
}

export interface ApplicantRepository {
  findById(auth: Authorization, id: string, tx?: Tx): Promise<Applicant | null>;
  findByEmail(
    auth: Authorization,
    email: string,
    batchIntakeId: string,
    tx?: Tx,
  ): Promise<Applicant | null>;
  list(auth: Authorization, filter?: ApplicantFilter, tx?: Tx): Promise<readonly Applicant[]>;
  create(
    auth: Authorization,
    applicant: Omit<Applicant, 'createdAt' | 'updatedAt'>,
    tx?: Tx,
  ): Promise<Applicant>;
  update(auth: Authorization, id: string, patch: Partial<Applicant>, tx?: Tx): Promise<Applicant>;
}

export interface StudentRepository {
  findById(auth: Authorization, id: string, tx?: Tx): Promise<Student | null>;
  findByStudentNumber(auth: Authorization, studentNumber: string, tx?: Tx): Promise<Student | null>;
  list(auth: Authorization, filter?: StudentFilter, tx?: Tx): Promise<readonly Student[]>;
  create(
    auth: Authorization,
    student: Omit<Student, 'createdAt' | 'updatedAt'>,
    tx?: Tx,
  ): Promise<Student>;
  update(auth: Authorization, id: string, patch: Partial<Student>, tx?: Tx): Promise<Student>;
}
