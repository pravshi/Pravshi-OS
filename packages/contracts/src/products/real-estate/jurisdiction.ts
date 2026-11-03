/**
 * Pravshi OS — Real Estate Jurisdiction Contracts & Registry (Layer 3).
 *
 * Provides extensible ISO-3166-2:IN jurisdiction format validation while strictly
 * registering Andhra Pradesh (IN-AP) and Telangana (IN-TG) as the active launch baselines.
 */
import { z } from 'zod';

/**
 * Validates ISO 3166-2:IN state codes (e.g. IN-AP, IN-TG, IN-KA, IN-MH).
 * Allows any Indian state/UT to be added via configuration without domain schema changes.
 */
export const JurisdictionCodeSchema = z
  .string()
  .regex(/^IN-[A-Z]{2}$/, 'Jurisdiction must be an ISO 3166-2:IN state code (e.g., IN-AP, IN-TG, IN-KA)');

export type JurisdictionCode = z.infer<typeof JurisdictionCodeSchema>;

/**
 * Well-known launch jurisdictions.
 * Andhra Pradesh and Telangana are the approved initial target markets.
 */
export const KNOWN_CONFIGURED_JURISDICTIONS = ['IN-AP', 'IN-TG'] as const;

export const KNOWN_JURISDICTIONS = {
  ANDHRA_PRADESH: 'IN-AP',
  TELANGANA: 'IN-TG',
} as const;

export type KnownJurisdiction = (typeof KNOWN_JURISDICTIONS)[keyof typeof KNOWN_JURISDICTIONS];

export const JURISDICTION_REGISTRATION_STATUSES = [
  'ACTIVE',
  'PILOT',
  'INACTIVE',
  'UNREGISTERED',
] as const;
export const JurisdictionRegistrationStatusEnum = z.enum(JURISDICTION_REGISTRATION_STATUSES);
export type JurisdictionRegistrationStatus = z.infer<typeof JurisdictionRegistrationStatusEnum>;

export const JurisdictionRegistryEntrySchema = z.object({
  jurisdictionCode: JurisdictionCodeSchema,
  jurisdictionName: z.string().min(2),
  status: JurisdictionRegistrationStatusEnum,
  isConfigured: z.boolean().default(false),
  effectiveVersion: z.string().min(1),
  registeredAt: z.string().datetime(),
});
export type JurisdictionRegistryEntry = z.infer<typeof JurisdictionRegistryEntrySchema>;

