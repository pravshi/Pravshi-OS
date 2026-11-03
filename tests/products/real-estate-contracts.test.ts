import { describe, expect, it } from 'vitest';
import {
  // Primitives & Base
  CalendarDateSchema,
  MoneyPaiseSchema,
  // Jurisdiction
  JurisdictionCodeSchema,
  JurisdictionRegistryEntrySchema,
  KNOWN_CONFIGURED_JURISDICTIONS,
  // Inventory & Area
  AreaMeasurementInputSchema,
  ResolvedAreaMeasurementSchema,
  InventoryAtomSchema,
  // Leads
  RealEstateLeadPreferencesSchema,
  LeadContractSchema,
  // Site Visits
  SiteVisitScheduleSchema,
  SiteVisitOutcomeInputSchema,
  SiteVisitOutcomeRecordSchema,
  VerificationProofDataSchema,
  // Transactions
  PricingStructureSchema,
  CostSheetSnapshotSchema,
  BookingContractSchema,
  // Compliance
  RegulatoryRuleContractSchema,
  JurisdictionComplianceConfigSchema,
} from '@pravshi/contracts';

describe('PR-RE-001: P0 Real Estate Contracts Freeze Test Suite', () => {
  // ── SUITE 1: MONEY SAFETY & ARITHMETIC OVERFLOW ─────────────────────────
  describe('Suite 1: Money Safety & Safe Integer Arithmetic', () => {
    it('accepts non-negative safe integers in paise', () => {
      expect(MoneyPaiseSchema.parse(0)).toBe(0);
      expect(MoneyPaiseSchema.parse(100)).toBe(100);
      // ₹75,00,000 = 750,000,000 paise
      expect(MoneyPaiseSchema.parse(750_000_000)).toBe(750_000_000);
      expect(MoneyPaiseSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('rejects negative, floating-point, unsafe integers and non-numbers', () => {
      expect(() => MoneyPaiseSchema.parse(-1)).toThrow();
      expect(() => MoneyPaiseSchema.parse(100.5)).toThrow();
      expect(() => MoneyPaiseSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
      expect(() => MoneyPaiseSchema.parse(Infinity)).toThrow();
      expect(() => MoneyPaiseSchema.parse(NaN)).toThrow();
      expect(() => MoneyPaiseSchema.parse('1000')).toThrow();
    });

    it('validates exact additive component equality in PricingStructure', () => {
      const validPricing = {
        baseAmountPaise: 50_000_000, // ₹5,00,000
        floorRisePaise: 5_000_000, // ₹50,000
        preferentialLocationChargePaise: 2_500_000,
        amenitiesChargePaise: 2_500_000,
        clubhouseMembershipChargePaise: 1_000_000,
        carParkingChargesPaise: 3_000_000,
        statutoryTaxesEstimatedPaise: 3_200_000,
        grossTotalPaise: 67_200_000, // exactly 50M + 5M + 2.5M + 2.5M + 1M + 3M + 3.2M
      };

      expect(() => PricingStructureSchema.parse(validPricing)).not.toThrow();
    });

    it('rejects PricingStructure when component sum does not equal grossTotalPaise', () => {
      const mismatchedPricing = {
        baseAmountPaise: 50_000_000,
        floorRisePaise: 5_000_000,
        preferentialLocationChargePaise: 0,
        amenitiesChargePaise: 0,
        clubhouseMembershipChargePaise: 0,
        carParkingChargesPaise: 0,
        statutoryTaxesEstimatedPaise: 0,
        grossTotalPaise: 54_000_000, // expected 55_000_000
      };

      expect(() => PricingStructureSchema.parse(mismatchedPricing)).toThrow(
        /FINANCIAL INTEGRITY ERROR/,
      );
    });

    it('rejects PricingStructure if component sum causes aggregate overflow beyond MAX_SAFE_INTEGER', () => {
      const overflowPricing = {
        baseAmountPaise: Number.MAX_SAFE_INTEGER - 100,
        floorRisePaise: 200, // causes sum to exceed MAX_SAFE_INTEGER
        preferentialLocationChargePaise: 0,
        amenitiesChargePaise: 0,
        clubhouseMembershipChargePaise: 0,
        carParkingChargesPaise: 0,
        statutoryTaxesEstimatedPaise: 0,
        grossTotalPaise: Number.MAX_SAFE_INTEGER + 100,
      };

      expect(() => PricingStructureSchema.parse(overflowPricing)).toThrow();
    });
  });

  // ── SUITE 2: LEGAL VERIFICATION TRUST & SAFETY CONSTRAINTS ───────────────
  describe('Suite 2: Legal Verification Trust & Safety Constraints', () => {
    const validEffectiveDate = '2026-01-01';

    it('strictly forbids hard_block on rules with PENDING_LEGAL_VERIFICATION', () => {
      const pendingRule = {
        jurisdiction: 'IN-AP',
        ruleIdentifier: 'RERA-SEC13-ADVANCE',
        sourceReference: 'RERA Act 2016, Section 13(1)',
        effectiveDate: validEffectiveDate,
        verificationStatus: 'PENDING_LEGAL_VERIFICATION',
        applicableWorkflow: 'booking_advance',
        enforcementBehavior: 'hard_block', // FORBIDDEN
        parameters: { maxAdvancePercentage: 10 },
      };

      expect(() => RegulatoryRuleContractSchema.parse(pendingRule)).toThrow(/SAFETY VIOLATION/);
    });

    it('permits advisory and warning on rules with PENDING_LEGAL_VERIFICATION', () => {
      const advisoryRule = {
        jurisdiction: 'IN-AP',
        ruleIdentifier: 'RERA-SEC13-ADVANCE',
        sourceReference: 'RERA Act 2016, Section 13(1)',
        effectiveDate: validEffectiveDate,
        verificationStatus: 'PENDING_LEGAL_VERIFICATION',
        applicableWorkflow: 'booking_advance',
        enforcementBehavior: 'advisory',
        parameters: { maxAdvancePercentage: 10 },
      };

      const warningRule = {
        ...advisoryRule,
        enforcementBehavior: 'warning',
      };

      expect(() => RegulatoryRuleContractSchema.parse(advisoryRule)).not.toThrow();
      expect(() => RegulatoryRuleContractSchema.parse(warningRule)).not.toThrow();
    });

    it('rejects hard_block when legal evidence is submitted without a trusted server approval stamp', () => {
      const untrustedRule = {
        jurisdiction: 'IN-TG',
        ruleIdentifier: 'TG-RERA-AGENT-REG',
        sourceReference: 'Telangana RERA Rules 2017, Rule 8',
        effectiveDate: validEffectiveDate,
        verificationStatus: 'VERIFIED_LEGAL_COUNSEL',
        applicableWorkflow: 'agent_onboarding',
        enforcementBehavior: 'hard_block',
        submittedEvidence: {
          verifiedByCounselName: 'Advocate K. Rao',
          barCouncilRegistrationNumber: 'AP/1234/2010',
          legalOpinionDocumentRef: 'DOC-LEGAL-2026-089',
          opinionDocumentSha256: 'a'.repeat(64),
          verifiedAt: '2026-01-15T10:00:00Z',
          statutoryGazetteReference: 'G.O.Ms.No. 115',
          verifiedScope: 'Mandatory agent registration before marketing',
        },
        serverApprovalStamp: null, // Untrusted: server stamp missing!
      };

      expect(() => RegulatoryRuleContractSchema.parse(untrustedRule)).toThrow(
        /hard_block enforcement strictly requires.*VERIFIED_TRUSTED server approval stamp/,
      );
    });

    it('permits hard_block only with VERIFIED_LEGAL_COUNSEL and VERIFIED_TRUSTED approval stamp', () => {
      const trustedRule = {
        jurisdiction: 'IN-TG',
        ruleIdentifier: 'TG-RERA-AGENT-REG',
        sourceReference: 'Telangana RERA Rules 2017, Rule 8',
        effectiveDate: validEffectiveDate,
        verificationStatus: 'VERIFIED_LEGAL_COUNSEL',
        applicableWorkflow: 'agent_onboarding',
        enforcementBehavior: 'hard_block',
        submittedEvidence: {
          verifiedByCounselName: 'Advocate K. Rao',
          barCouncilRegistrationNumber: 'AP/1234/2010',
          legalOpinionDocumentRef: 'DOC-LEGAL-2026-089',
          opinionDocumentSha256: 'b'.repeat(64),
          verifiedAt: '2026-01-15T10:00:00Z',
          statutoryGazetteReference: 'G.O.Ms.No. 115',
          verifiedScope: 'Mandatory agent registration before marketing',
        },
        serverApprovalStamp: {
          platformReviewerUserId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          verifiedAuditLogId: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
          trustedVerificationTimestamp: '2026-01-16T12:00:00Z',
          verificationTrustStatus: 'VERIFIED_TRUSTED',
        },
      };

      expect(() => RegulatoryRuleContractSchema.parse(trustedRule)).not.toThrow();
    });

    it('requires NOT_APPLICABLE rules to have enforcementBehavior disabled', () => {
      const notApplicableRule = {
        jurisdiction: 'IN-AP',
        ruleIdentifier: 'MAHA-SPECIFIC-RULE',
        sourceReference: 'Non-applicable regional act',
        effectiveDate: validEffectiveDate,
        verificationStatus: 'NOT_APPLICABLE',
        applicableWorkflow: 'project_publish',
        enforcementBehavior: 'advisory', // should be disabled
      };

      expect(() => RegulatoryRuleContractSchema.parse(notApplicableRule)).toThrow(
        /must have enforcementBehavior set to disabled/,
      );
    });
  });

  // ── SUITE 3: JURISDICTION EXTENSIBILITY & REGISTRY ───────────────────────
  describe('Suite 3: Jurisdiction Extensibility & Registry', () => {
    it('accepts initial target launch jurisdictions IN-AP and IN-TG', () => {
      expect(JurisdictionCodeSchema.parse('IN-AP')).toBe('IN-AP');
      expect(JurisdictionCodeSchema.parse('IN-TG')).toBe('IN-TG');
      expect(KNOWN_CONFIGURED_JURISDICTIONS).toContain('IN-AP');
      expect(KNOWN_CONFIGURED_JURISDICTIONS).toContain('IN-TG');
    });

    it('accepts syntactically valid future Indian state codes without contract changes', () => {
      expect(JurisdictionCodeSchema.parse('IN-KA')).toBe('IN-KA');
      expect(JurisdictionCodeSchema.parse('IN-MH')).toBe('IN-MH');
      expect(JurisdictionCodeSchema.parse('IN-TN')).toBe('IN-TN');
    });

    it('rejects invalid jurisdiction syntax', () => {
      expect(() => JurisdictionCodeSchema.parse('AP')).toThrow();
      expect(() => JurisdictionCodeSchema.parse('USA')).toThrow();
      expect(() => JurisdictionCodeSchema.parse('IN-ANDHRA')).toThrow();
      expect(() => JurisdictionCodeSchema.parse('123')).toThrow();
      expect(() => JurisdictionCodeSchema.parse('IN-12')).toThrow();
    });

    it('parses JurisdictionRegistryEntry contracts distinguishing active from unregistered', () => {
      const activeEntry = {
        jurisdictionCode: 'IN-AP',
        jurisdictionName: 'Andhra Pradesh',
        status: 'ACTIVE',
        isConfigured: true,
        effectiveVersion: '2026.1',
        registeredAt: '2026-01-01T00:00:00Z',
      };
      const unregisteredEntry = {
        jurisdictionCode: 'IN-KA',
        jurisdictionName: 'Karnataka',
        status: 'UNREGISTERED',
        isConfigured: false,
        effectiveVersion: '0.0.0',
        registeredAt: '2026-01-01T00:00:00Z',
      };

      expect(() => JurisdictionRegistryEntrySchema.parse(activeEntry)).not.toThrow();
      expect(() => JurisdictionRegistryEntrySchema.parse(unregisteredEntry)).not.toThrow();
    });
  });

  // ── SUITE 4: AREA MEASUREMENT & PROVENANCE TRUST ─────────────────────────
  describe('Suite 4: Area Measurement & Provenance Trust', () => {
    it('accepts raw client input without conversion factors or authority claims', () => {
      const clientInput = {
        enteredValue: 2,
        enteredUnit: 'gunta',
        targetJurisdiction: 'IN-TG',
        districtOrMicroMarket: 'Rangareddy',
      };

      const parsed = AreaMeasurementInputSchema.parse(clientInput);
      expect(parsed.enteredValue).toBe(2);
      expect(parsed.enteredUnit).toBe('gunta');
    });

    it('validates server-resolved Gunta conversion in Telangana (1 Gunta = 1089 Sq Ft)', () => {
      const resolvedGunta = {
        enteredValue: 2,
        enteredUnit: 'gunta',
        jurisdiction: 'IN-TG',
        districtOrMicroMarket: 'Rangareddy',
        conversionFactorToSqFt: 1089,
        provenance: {
          sourceAuthority: 'TG_LAND_REVENUE_ACT',
          effectiveVersion: '2024.1',
          sourceCitation: 'Telangana Land Revenue Act / Standard Revenue Units',
          districtOrMicroMarket: 'Rangareddy',
          isLegallyAuthoritative: false, // Marked unverified pending official gazette
        },
        normalizedSqFt: 2178, // exactly 2 * 1089
        resolvedAt: '2026-01-01T00:00:00Z',
      };

      expect(() => ResolvedAreaMeasurementSchema.parse(resolvedGunta)).not.toThrow();
    });

    it('validates server-resolved Ankanam conversion in Nellore (1 Ankanam = 72 Sq Ft)', () => {
      const resolvedAnkanam = {
        enteredValue: 100,
        enteredUnit: 'ankanam',
        jurisdiction: 'IN-AP',
        districtOrMicroMarket: 'Nellore',
        conversionFactorToSqFt: 72,
        provenance: {
          sourceAuthority: 'DISTRICT_COLLECTORATE_CUSTOMARY_RECORD',
          effectiveVersion: '2024.1',
          sourceCitation: 'Nellore District Customary Measurement Practice',
          districtOrMicroMarket: 'Nellore',
          isLegallyAuthoritative: false,
        },
        normalizedSqFt: 7200, // exactly 100 * 72
        resolvedAt: '2026-01-01T00:00:00Z',
      };

      expect(() => ResolvedAreaMeasurementSchema.parse(resolvedAnkanam)).not.toThrow();
    });

    it('rejects ResolvedAreaMeasurement if normalizedSqFt does not match enteredValue * factor', () => {
      const mismatchedArea = {
        enteredValue: 2,
        enteredUnit: 'gunta',
        jurisdiction: 'IN-TG',
        conversionFactorToSqFt: 1089,
        provenance: {
          sourceAuthority: 'TG_LAND_REVENUE_ACT',
          effectiveVersion: '2024.1',
          sourceCitation: 'Telangana Revenue Record',
          isLegallyAuthoritative: false,
        },
        normalizedSqFt: 2000, // Expected 2178
        resolvedAt: '2026-01-01T00:00:00Z',
      };

      expect(() => ResolvedAreaMeasurementSchema.parse(mismatchedArea)).toThrow(
        /normalizedSqFt must match/,
      );
    });

    it('rejects negative area values or negative conversion factors', () => {
      expect(() =>
        AreaMeasurementInputSchema.parse({
          enteredValue: -5,
          enteredUnit: 'sqft',
          targetJurisdiction: 'IN-AP',
        }),
      ).toThrow();
    });
  });

  // ── SUITE 5: SITE VISIT TIMING & DPDP PRIVACY ────────────────────────────
  describe('Suite 5: Site Visit Timing & DPDP Privacy', () => {
    it('rejects SiteVisitSchedule when scheduledEndTime <= scheduledStartTime', () => {
      const invalidSchedule = {
        id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        organizationId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
        leadId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
        propertyOrProjectId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
        assignedAgentId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15',
        scheduledStartTime: '2026-03-10T14:00:00Z',
        scheduledEndTime: '2026-03-10T13:00:00Z', // Before start!
      };

      expect(() => SiteVisitScheduleSchema.parse(invalidSchedule)).toThrow(
        /scheduledEndTime must be strictly later than scheduledStartTime/,
      );
    });

    it('rejects SiteVisitOutcomeInput if completedAt is in the future', () => {
      const futureCompleted = {
        siteVisitId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        completedAt: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        outcomeStatus: 'completed',
        verificationProof: {
          method: 'otp',
          telecomMessageRef: 'MSG-TEL-12345',
          verifiedTokenSha256: 'c'.repeat(64),
          verifiedAt: '2026-03-10T14:30:00Z',
        },
        interestLevel: 'high',
        feedbackNotes: 'Customer loved the high ceiling and lake view.',
      };

      expect(() => SiteVisitOutcomeInputSchema.parse(futureCompleted)).toThrow(
        /completedAt cannot be in the future/,
      );
    });

    it('parses valid OTP and manual override verification proofs', () => {
      const otpProof = {
        method: 'otp',
        telecomMessageRef: 'MSG-TEL-98765',
        verifiedTokenSha256: 'd'.repeat(64),
        verifiedAt: '2026-03-10T14:30:00Z',
      };

      const manualOverrideProof = {
        method: 'manual_override',
        overrideAuthorizedByUserId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        overrideReason:
          'Network outage at remote project site; manager manually verified via customer phone confirmation.',
      };

      expect(() => VerificationProofDataSchema.parse(otpProof)).not.toThrow();
      expect(() => VerificationProofDataSchema.parse(manualOverrideProof)).not.toThrow();
    });

    it('rejects manual override if reason is under 15 characters', () => {
      const shortReason = {
        method: 'manual_override',
        overrideAuthorizedByUserId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        overrideReason: 'Network down', // Only 12 chars
      };

      expect(() => VerificationProofDataSchema.parse(shortReason)).toThrow(
        /at least 15 characters/,
      );
    });

    it('validates server-derived SiteVisitOutcomeRecord with authoritative 24h discipline', () => {
      const serverRecord = {
        siteVisitId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        completedAt: '2026-03-10T15:00:00Z',
        outcomeStatus: 'completed',
        verificationProof: {
          method: 'otp',
          telecomMessageRef: 'MSG-TEL-12345',
          verifiedTokenSha256: 'e'.repeat(64),
          verifiedAt: '2026-03-10T15:00:00Z',
        },
        interestLevel: 'high',
        feedbackNotes: 'Buyer agreed on standard pricing; waiting for token collection.',
        isCompletedWithin24Hours: true, // Server authoritative derivation
        serverRecordedAt: '2026-03-10T15:05:00Z',
      };

      expect(() => SiteVisitOutcomeRecordSchema.parse(serverRecord)).not.toThrow();
    });
  });

  // ── SUITE 6: COST SHEET SNAPSHOT & BOOKING INTEGRITY ─────────────────────
  describe('Suite 6: Cost Sheet Snapshot & Booking Integrity', () => {
    const validPricing = {
      baseAmountPaise: 80_000_000,
      floorRisePaise: 0,
      preferentialLocationChargePaise: 0,
      amenitiesChargePaise: 5_000_000,
      clubhouseMembershipChargePaise: 0,
      carParkingChargesPaise: 5_000_000,
      statutoryTaxesEstimatedPaise: 4_500_000,
      grossTotalPaise: 94_500_000, // ₹94,500
    };

    const validSnapshot = {
      costSheetId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      inventoryAtomId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      snapshotHash: 'f'.repeat(64),
      pricing: validPricing,
      approvedByUserId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
      validUntil: '2026-04-01T00:00:00Z',
    };

    it('rejects CostSheetSnapshot with non-hex or short snapshotHash', () => {
      expect(() =>
        CostSheetSnapshotSchema.parse({
          ...validSnapshot,
          snapshotHash: 'short-hash',
        }),
      ).toThrow(/64-character lowercase SHA-256 hash/);
    });

    it('rejects BookingContract if totalAgreedValuePaise does not match snapshot grossTotalPaise', () => {
      const mismatchedBooking = {
        id: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        organizationId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
        dealId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
        inventoryAtomId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
        buyerContactId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15',
        status: 'token_received',
        costSheetSnapshot: validSnapshot,
        totalAgreedValuePaise: 90_000_000, // Does not match snapshot grossTotalPaise 94_500_000!
        cumulativeCollectionsPaise: 5_000_000,
        statutoryGateStatus: 'cleared',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
      };

      expect(() => BookingContractSchema.parse(mismatchedBooking)).toThrow(
        /totalAgreedValuePaise must exactly match costSheetSnapshot.pricing.grossTotalPaise/,
      );
    });

    it('rejects BookingContract if cumulativeCollectionsPaise exceeds totalAgreedValuePaise', () => {
      const overcollectedBooking = {
        id: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        organizationId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
        dealId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
        inventoryAtomId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
        buyerContactId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15',
        status: 'token_received',
        costSheetSnapshot: validSnapshot,
        totalAgreedValuePaise: 94_500_000,
        cumulativeCollectionsPaise: 100_000_000, // Exceeds 94_500_000!
        statutoryGateStatus: 'cleared',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
      };

      expect(() => BookingContractSchema.parse(overcollectedBooking)).toThrow(
        /cumulativeCollectionsPaise cannot exceed totalAgreedValuePaise/,
      );
    });

    it('requires registeredAgreementNumber and date when status is agreement_registered', () => {
      const incompleteRegisteredBooking = {
        id: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        organizationId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
        dealId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
        inventoryAtomId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
        buyerContactId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15',
        status: 'agreement_registered',
        costSheetSnapshot: validSnapshot,
        totalAgreedValuePaise: 94_500_000,
        cumulativeCollectionsPaise: 20_000_000,
        registeredAgreementDate: null, // Incomplete!
        registeredAgreementNumber: null,
        statutoryGateStatus: 'cleared',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
      };

      expect(() => BookingContractSchema.parse(incompleteRegisteredBooking)).toThrow(
        /agreement_registered status requires non-empty registeredAgreementNumber/,
      );
    });
  });

  // ── SUITE 7: CALENDAR DATE & BUDGET CROSS-FIELD VALIDATIONS ──────────────
  describe('Suite 7: Calendar Date & Budget Cross-Field Validations', () => {
    it('rejects invalid calendar dates like 2026-02-31 and 2026-04-31', () => {
      expect(() => CalendarDateSchema.parse('2026-02-31')).toThrow(/Must be a valid calendar date/);
      expect(() => CalendarDateSchema.parse('2026-04-31')).toThrow(/Must be a valid calendar date/);
      expect(() => CalendarDateSchema.parse('2026-13-01')).toThrow(/Must be a valid calendar date/);
      expect(() => CalendarDateSchema.parse('not-a-date')).toThrow();
    });

    it('accepts valid calendar dates including leap years', () => {
      expect(CalendarDateSchema.parse('2026-02-28')).toBe('2026-02-28');
      expect(CalendarDateSchema.parse('2024-02-29')).toBe('2024-02-29'); // 2024 leap year
      expect(CalendarDateSchema.parse('2026-11-03')).toBe('2026-11-03');
    });

    it('rejects RealEstateLeadPreferences when budgetMinPaise > budgetMaxPaise', () => {
      const invertedBudget = {
        leadId: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        targetJurisdiction: 'IN-TG',
        budgetMinPaise: 50_000_000, // ₹50L
        budgetMaxPaise: 40_000_000, // ₹40L (Min > Max!)
      };

      expect(() => RealEstateLeadPreferencesSchema.parse(invertedBudget)).toThrow(
        /budgetMinPaise must not exceed budgetMaxPaise/,
      );
    });

    it('accepts RealEstateLeadPreferences when budgetMinPaise <= budgetMaxPaise', () => {
      const validBudget = {
        leadId: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        targetJurisdiction: 'IN-TG',
        preferredLocalities: ['Gachibowli', 'Madhapur'],
        propertyTypes: ['apartment'],
        bhkPreferences: ['2bhk', '3bhk'],
        budgetMinPaise: 40_000_000,
        budgetMaxPaise: 75_000_000,
      };

      expect(() => RealEstateLeadPreferencesSchema.parse(validBudget)).not.toThrow();
    });
  });
});
