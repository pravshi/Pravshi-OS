import { describe, expect, it } from 'vitest';
import {
  LeadContractSchema,
  LeadCaptureInputSchema,
  LEAD_STAGES,
  LEAD_SOURCES,
  CrmTaskSchema,
  CreateCrmTaskInputSchema,
  UpdateCrmTaskInputSchema,
  AttributionCorrectionSchema,
  RequestAttributionCorrectionInputSchema,
  ReviewAttributionCorrectionInputSchema,
  ATTRIBUTION_FIELDS,
  ATTRIBUTION_STATUSES,
} from '@pravshi/contracts';

describe('PR-P1-01: CRM Shared Contracts Validation Suite', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const leadId = '22222222-2222-4222-8222-222222222222';
  const contactId = '33333333-3333-4333-8333-333333333333';
  const personId = '44444444-4444-4444-8444-444444444444';
  const taskId = '55555555-5555-4555-8555-555555555555';
  const correctionId = '66666666-6666-4666-8666-666666666666';
  const nowIso = new Date().toISOString();

  describe('Suite 1: Lead Contract & Ingestion Schemas', () => {
    it('validates a complete LeadContractSchema payload', () => {
      const validLead = {
        id: leadId,
        organizationId: orgId,
        fullName: 'Aarav Patel',
        primaryPhone: '+919876543210',
        email: 'aarav@example.com',
        source: 'website',
        stage: 'new',
        slaDueAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const parsed = LeadContractSchema.safeParse(validLead);
      expect(parsed.success).toBe(true);
    });

    it('rejects invalid non-E.164 phone numbers', () => {
      const invalidPhoneLead = {
        id: leadId,
        organizationId: orgId,
        fullName: 'Invalid Phone',
        primaryPhone: '9876543210', // Missing +
        source: 'manual',
        slaDueAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const parsed = LeadContractSchema.safeParse(invalidPhoneLead);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const phoneError = parsed.error.issues.find((i) => i.path.includes('primaryPhone'));
        expect(phoneError?.message).toContain('E.164');
      }
    });

    it('confirms conversionDealId is completely removed from schema', () => {
      const parsedKeys = Object.keys(LeadContractSchema.shape);
      expect(parsedKeys).not.toContain('conversionDealId');
      expect(parsedKeys).toContain('convertedContactId');
      expect(parsedKeys).toContain('conversionContactId');
    });

    it('validates lead capture input with optional consent proof', () => {
      const input = {
        fullName: 'Priya Sharma',
        primaryPhone: '+919123456789',
        email: 'priya@example.com',
        source: 'website',
        consentProof: {
          channel: 'whatsapp' as const,
          capturedAt: nowIso,
          optInText: 'I agree to be contacted via WhatsApp',
        },
      };

      const parsed = LeadCaptureInputSchema.safeParse(input);
      expect(parsed.success).toBe(true);
    });
  });

  describe('Suite 2: CRM Tasks Contract & XOR Target Invariant', () => {
    it('accepts task referencing leadId only', () => {
      const leadTask = {
        id: taskId,
        organizationId: orgId,
        leadId,
        title: 'Initial Discovery Call',
        taskType: 'CALL_BACK',
        dueAt: nowIso,
        assigneePersonId: personId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const parsed = CrmTaskSchema.safeParse(leadTask);
      expect(parsed.success).toBe(true);
    });

    it('accepts task referencing contactId only', () => {
      const contactTask = {
        id: taskId,
        organizationId: orgId,
        contactId,
        title: 'Send Revised Agreement Draft',
        taskType: 'DOCUMENT_COLLECTION',
        dueAt: nowIso,
        assigneePersonId: personId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const parsed = CrmTaskSchema.safeParse(contactTask);
      expect(parsed.success).toBe(true);
    });

    it('rejects task referencing BOTH leadId and contactId (XOR violation)', () => {
      const dualTargetTask = {
        id: taskId,
        organizationId: orgId,
        leadId,
        contactId,
        title: 'Ambiguous Task Target',
        taskType: 'FOLLOW_UP',
        dueAt: nowIso,
        assigneePersonId: personId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const parsed = CrmTaskSchema.safeParse(dualTargetTask);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain(
          'Task must reference exactly one of leadId or contactId',
        );
      }
    });

    it('rejects task referencing NEITHER leadId nor contactId (XOR violation)', () => {
      const orphanTask = {
        id: taskId,
        organizationId: orgId,
        title: 'Orphan Target Task',
        taskType: 'GENERAL',
        dueAt: nowIso,
        assigneePersonId: personId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const parsed = CrmTaskSchema.safeParse(orphanTask);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain(
          'Task must reference exactly one of leadId or contactId',
        );
      }
    });

    it('enforces XOR refinement on CreateCrmTaskInputSchema', () => {
      const invalidInput = {
        leadId,
        contactId,
        title: 'Dual Target Creation',
        taskType: 'SITE_VISIT' as const,
        dueAt: nowIso,
        assigneePersonId: personId,
      };

      const parsed = CreateCrmTaskInputSchema.safeParse(invalidInput);
      expect(parsed.success).toBe(false);
    });
  });

  describe('Suite 3: Attribution Correction Governance Contract', () => {
    it('validates a valid attribution correction request', () => {
      const req = {
        leadId,
        fieldName: 'source' as const,
        newValue: 'portal_99acres',
        reason: 'Customer stated they found our property via 99acres portal listing',
      };

      const parsed = RequestAttributionCorrectionInputSchema.safeParse(req);
      expect(parsed.success).toBe(true);
    });

    it('rejects attribution correction request with reason shorter than 10 chars', () => {
      const shortReasonReq = {
        leadId,
        fieldName: 'source' as const,
        newValue: 'manual',
        reason: 'wrong', // < 10 chars
      };

      const parsed = RequestAttributionCorrectionInputSchema.safeParse(shortReasonReq);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain('at least 10 characters');
      }
    });

    it('validates review decision schema', () => {
      const approveDecision = {
        correctionId,
        decision: 'APPROVE' as const,
      };
      expect(ReviewAttributionCorrectionInputSchema.safeParse(approveDecision).success).toBe(true);

      const rejectDecision = {
        correctionId,
        decision: 'REJECT' as const,
        rejectionReason: 'Source attribution confirmed as website ad campaign',
      };
      expect(ReviewAttributionCorrectionInputSchema.safeParse(rejectDecision).success).toBe(true);
    });
  });
});
