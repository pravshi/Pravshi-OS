/**
 * Real Estate API — Zod Validation Schemas and Route Contracts.
 */

import { z } from 'zod';
import {
  PROPERTY_TYPES,
  LISTING_CATEGORIES,
  LISTING_STATUSES,
  FURNISHING_STATUSES,
  FACING_DIRECTIONS,
} from '../domain/listing';
import { VERIFICATION_METHODS, CLIENT_INTEREST_LEVELS } from '../domain/site-visit';
import { REAL_ESTATE_DEAL_STAGES, BROKER_ROLES } from '../domain/deal';

export const PricingStructureSchema = z.object({
  basePrice: z.number().positive('Base price must be greater than zero'),
  currency: z.string().length(3, 'Currency must be a 3-letter ISO code').default('INR'),
  maintenancePerMonth: z.number().nonnegative().optional(),
  securityDeposit: z.number().nonnegative().optional(),
  negotiable: z.boolean().default(false),
  pricePerSqFt: z.number().positive().optional(),
  taxOrGstPercentage: z.number().min(0).max(100).optional(),
});

export const GeoLocationSchema = z.object({
  addressLine1: z.string().min(3),
  addressLine2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  postalCode: z.string().min(3),
  country: z.string().min(2),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  landmark: z.string().optional(),
});

export const PropertyUnitSchema = z.object({
  id: z.string().uuid().optional(),
  unitNumber: z.string().min(1),
  floor: z.number().int(),
  carpetAreaSqFt: z.number().positive(),
  superBuiltUpAreaSqFt: z.number().positive().optional(),
  bedrooms: z.number().int().min(0),
  bathrooms: z.number().int().min(0),
  balconyCount: z.number().int().min(0).default(0),
  furnishingStatus: z.enum(FURNISHING_STATUSES).default('unfurnished'),
  facingDirection: z.enum(FACING_DIRECTIONS).optional(),
  parkingSlots: z.number().int().min(0).default(0),
  isAvailable: z.boolean().default(true),
});

export const CreateListingSchema = z.object({
  title: z.string().min(5).max(255),
  slug: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lower-case kebab-case'),
  description: z.string().min(10),
  propertyType: z.enum(PROPERTY_TYPES),
  category: z.enum(LISTING_CATEGORIES),
  pricing: PricingStructureSchema,
  location: GeoLocationSchema,
  units: z.array(PropertyUnitSchema).min(1, 'At least one property unit is required'),
  amenities: z.array(z.string()).default([]),
  images: z.array(z.string().url()).default([]),
});

export type CreateListingInput = z.infer<typeof CreateListingSchema>;

export const UpdateListingSchema = CreateListingSchema.partial().extend({
  status: z.enum(LISTING_STATUSES).optional(),
});

export type UpdateListingInput = z.infer<typeof UpdateListingSchema>;

export const ScheduleSiteVisitSchema = z.object({
  listingId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  leadOrContactId: z.string().uuid(),
  agentId: z.string().uuid(),
  scheduledStartTime: z.coerce.date(),
  scheduledEndTime: z.coerce.date(),
});

export type ScheduleSiteVisitInput = z.infer<typeof ScheduleSiteVisitSchema>;

export const RecordSiteVisitFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  interestLevel: z.enum(CLIENT_INTEREST_LEVELS),
  verificationMethod: z.enum(VERIFICATION_METHODS),
  notes: z.string().optional(),
  followUpAction: z.string().optional(),
  followUpDate: z.coerce.date().optional(),
});

export type RecordSiteVisitFeedbackInput = z.infer<typeof RecordSiteVisitFeedbackSchema>;

export const CommissionSplitSchema = z.object({
  recipientId: z.string().uuid(),
  recipientName: z.string().min(1),
  role: z.enum(BROKER_ROLES),
  percentage: z.number().min(0).max(100),
  fixedAmount: z.number().nonnegative().optional(),
});

export const RecordBookingTokenSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3).default('INR'),
  paymentMethod: z.enum(['bank_transfer', 'cheque', 'card', 'upi', 'escrow']),
  paymentReference: z.string().min(1),
  refundable: z.boolean().default(true),
  refundTerms: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
});

export const ManageDealSchema = z.object({
  stage: z.enum(REAL_ESTATE_DEAL_STAGES),
  agreedPrice: z.number().positive().optional(),
  bookingToken: RecordBookingTokenSchema.optional(),
  commissionSplits: z.array(CommissionSplitSchema).optional(),
  lostReason: z.string().optional(),
});

export type ManageDealInput = z.infer<typeof ManageDealSchema>;

/**
 * Canonical Real Estate contract schemas re-exported from @pravshi/contracts (Layer 3).
 */
export {
  // Primitives & Money
  MoneyPaiseSchema,
  CalendarDateSchema,
  // Jurisdiction
  JurisdictionCodeSchema,
  JurisdictionRegistryEntrySchema,
  // Inventory & Area
  AreaMeasurementInputSchema,
  ResolvedAreaMeasurementSchema,
  AreaMeasurementSchema,
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
  PricingStructureSchema as PricingStructurePaiseSchema,
  CostSheetSnapshotSchema,
  BookingContractSchema,
  // Compliance
  RegulatoryRuleContractSchema,
  JurisdictionComplianceConfigSchema,
} from '@pravshi/contracts';
