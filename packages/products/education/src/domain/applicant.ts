/**
 * Education Domain — Applicants, Enquiries, Applications, Counselling.
 *
 * Implements applicant lifecycle, document verification rules, and counselling workflows.
 */

export const APPLICANT_STAGES = [
  'enquiry',
  'counselling_scheduled',
  'counselling_completed',
  'application_submitted',
  'documents_verified',
  'entrance_test',
  'interview',
  'offer_extended',
  'offer_accepted',
  'fee_paid',
  'rejected',
  'withdrawn',
] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];

export const DOCUMENT_TYPES = [
  'id_proof',
  'transcript',
  'degree_certificate',
  'recommendation_letter',
  'statement_of_purpose',
  'financial_proof',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'] as const;
export type DocumentVerificationStatus = (typeof DOCUMENT_VERIFICATION_STATUSES)[number];

export interface ApplicationDocument {
  readonly id: string;
  readonly docType: DocumentType;
  readonly title: string;
  readonly fileUrl: string;
  readonly status: DocumentVerificationStatus;
  readonly verifiedAt?: Date;
  readonly verifiedBy?: string;
  readonly rejectionReason?: string;
}

export interface CounsellingSession {
  readonly id: string;
  readonly applicantId: string;
  readonly counsellorId: string;
  readonly scheduledAt: Date;
  readonly status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  readonly notes?: string;
  readonly recommendation?: 'admit' | 'reject' | 'conditional_admit' | 'follow_up_needed';
}

export interface Applicant {
  readonly id: string;
  readonly organizationId: string;
  readonly programId: string;
  readonly batchIntakeId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  readonly stage: ApplicantStage;
  readonly counsellingSessions: readonly CounsellingSession[];
  readonly documents: readonly ApplicationDocument[];
  readonly offerLetterUrl?: string;
  readonly offerExtendedAt?: Date;
  readonly offerAcceptedAt?: Date;
  readonly rejectionReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ApplicantDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApplicantDomainError';
  }
}

/**
 * Invariant: Check that mandatory documents (id_proof, transcript) are verified before offer extension.
 */
export function assertAllMandatoryDocumentsVerified(
  documents: readonly ApplicationDocument[],
): void {
  const mandatory: DocumentType[] = ['id_proof', 'transcript'];
  for (const docType of mandatory) {
    const doc = documents.find((d) => d.docType === docType);
    if (!doc) {
      throw new ApplicantDomainError(
        `Mandatory document missing: ${docType}`,
        'MISSING_MANDATORY_DOC',
      );
    }
    if (doc.status !== 'verified') {
      throw new ApplicantDomainError(
        `Mandatory document ${docType} has not been verified`,
        'UNVERIFIED_MANDATORY_DOC',
      );
    }
  }
}
