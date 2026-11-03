/**
 * Pravshi OS — Real Estate InventoryAtom & Area Measurement Contracts (Layer 3).
 *
 * Implements strict separation between client-supplied raw area inputs and
 * server-resolved authoritative conversions with regional provenance.
 */
import { z } from 'zod';
import { UuidSchema } from '../../base';
import { JurisdictionCodeSchema } from './jurisdiction';

export const AREA_UNITS = [
  'sqft',
  'sqmt',
  'sqyd',
  'gunta',
  'ankanam',
  'cent',
  'acre',
  'hectare',
  'marla',
  'bigha',
  'custom',
] as const;

export const AreaUnitEnum = z.enum(AREA_UNITS);
export type AreaUnit = z.infer<typeof AreaUnitEnum>;

export const AREA_CONVERSION_AUTHORITIES = [
  'CENTRAL_STANDARDS_OF_WEIGHTS_AND_MEASURES',
  'AP_REVENUE_BOARD_STANDARD',
  'TG_LAND_REVENUE_ACT',
  'DISTRICT_COLLECTORATE_CUSTOMARY_RECORD',
  'TENANT_LOCAL_OPERATIONAL_CONFIG',
] as const;

export const AreaConversionProvenanceSchema = z.object({
  sourceAuthority: z.enum(AREA_CONVERSION_AUTHORITIES),
  effectiveVersion: z.string().min(1, 'effectiveVersion is required'),
  sourceCitation: z.string().min(3, 'sourceCitation must provide verifiable statutory or municipal reference'),
  districtOrMicroMarket: z.string().optional(),
  isLegallyAuthoritative: z.boolean().default(false),
});
export type AreaConversionProvenance = z.infer<typeof AreaConversionProvenanceSchema>;

/**
 * Client submission payload: Accepts raw user input only.
 * Clients are strictly forbidden from supplying conversion factors or claiming legal authority.
 */
export const AreaMeasurementInputSchema = z.object({
  enteredValue: z.number().positive('Entered area value must be positive'),
  enteredUnit: AreaUnitEnum,
  targetJurisdiction: JurisdictionCodeSchema,
  districtOrMicroMarket: z.string().optional(),
});
export type AreaMeasurementInput = z.infer<typeof AreaMeasurementInputSchema>;

/**
 * Server-resolved authoritative measurement record.
 * Normalization math is strictly validated to 4 decimal places.
 */
export const ResolvedAreaMeasurementSchema = z
  .object({
    enteredValue: z.number().positive('Entered area value must be positive'),
    enteredUnit: AreaUnitEnum,
    jurisdiction: JurisdictionCodeSchema,
    districtOrMicroMarket: z.string().optional(),
    conversionFactorToSqFt: z.number().positive('Conversion factor must be positive'),
    provenance: AreaConversionProvenanceSchema,
    normalizedSqFt: z.number().positive('Normalized Sq Ft must be positive'),
    resolvedAt: z.string().datetime(),
  })
  .refine(
    (data) => {
      const expected = Number((data.enteredValue * data.conversionFactorToSqFt).toFixed(4));
      const actual = Number(data.normalizedSqFt.toFixed(4));
      return Math.abs(expected - actual) <= 0.0001;
    },
    {
      message: 'normalizedSqFt must match enteredValue * conversionFactorToSqFt within rounding tolerance (4 decimal places)',
      path: ['normalizedSqFt'],
    }
  );

export type ResolvedAreaMeasurement = z.infer<typeof ResolvedAreaMeasurementSchema>;
export const AreaMeasurementSchema = ResolvedAreaMeasurementSchema;
export type AreaMeasurement = ResolvedAreaMeasurement;

export const INVENTORY_ATOM_TYPES = [
  'unit',
  'floor',
  'tower',
  'plot',
  'land_parcel',
  'villa',
  'commercial_space',
] as const;
export const InventoryAtomTypeEnum = z.enum(INVENTORY_ATOM_TYPES);
export type InventoryAtomType = z.infer<typeof InventoryAtomTypeEnum>;

export const INVENTORY_ATOM_STATUSES = [
  'available',
  'hold',
  'blocked',
  'booked',
  'sold',
  'leased',
  'inactive',
] as const;
export const InventoryAtomStatusEnum = z.enum(INVENTORY_ATOM_STATUSES);
export type InventoryAtomStatus = z.infer<typeof InventoryAtomStatusEnum>;

export const InventoryAtomSchema = z.object({
  id: UuidSchema,
  organizationId: UuidSchema,
  atomType: InventoryAtomTypeEnum,
  parentAtomId: UuidSchema.nullable().optional(),
  identifier: z.string().min(1).max(100),
  displayLabel: z.string().min(1).max(255),
  jurisdiction: JurisdictionCodeSchema,
  reraRegistrationNumber: z.string().nullable().optional(),
  carpetArea: ResolvedAreaMeasurementSchema,
  superBuiltUpArea: ResolvedAreaMeasurementSchema.optional(),
  status: InventoryAtomStatusEnum,
  statusReason: z.string().optional(),
  activeHoldExpiresAt: z.string().datetime().nullable().optional(),
  activeBookingId: UuidSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InventoryAtom = z.infer<typeof InventoryAtomSchema>;
