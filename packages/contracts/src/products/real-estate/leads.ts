/**
 * Pravshi OS — Real Estate Lead Preferences Contract (Layer 3).
 *
 * Extends the generic CRM Lead with domain-specific property preferences,
 * micro-market locations, and safe budget ranges in integer paise.
 */
import { z } from 'zod';
import { UuidSchema, MoneyPaiseSchema } from '../../base';
import { JurisdictionCodeSchema } from './jurisdiction';

export const PROPERTY_TYPES = [
  'apartment',
  'villa',
  'plot',
  'commercial',
  'farm_land',
] as const;
export const PropertyTypeEnum = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof PropertyTypeEnum>;

export const BHK_PREFERENCES = [
  '1bhk',
  '2bhk',
  '2.5bhk',
  '3bhk',
  '3.5bhk',
  '4bhk_plus',
  'plot_only',
  'commercial',
] as const;
export const BhkPreferenceEnum = z.enum(BHK_PREFERENCES);
export type BhkPreference = z.infer<typeof BhkPreferenceEnum>;

export const POSSESSION_TIMELINES = [
  'ready_to_move',
  'under_construction_6m',
  'under_construction_12m',
  'under_construction_24m_plus',
] as const;
export const PossessionTimelineEnum = z.enum(POSSESSION_TIMELINES);
export type PossessionTimeline = z.infer<typeof PossessionTimelineEnum>;

export const RealEstateLeadPreferencesSchema = z
  .object({
    leadId: UuidSchema,
    targetJurisdiction: JurisdictionCodeSchema,
    preferredLocalities: z.array(z.string().min(2)).default([]),
    propertyTypes: z.array(PropertyTypeEnum).default([]),
    bhkPreferences: z.array(BhkPreferenceEnum).default([]),
    budgetMinPaise: MoneyPaiseSchema,
    budgetMaxPaise: MoneyPaiseSchema,
    purpose: z.enum(['end_use', 'investment']).default('end_use'),
    possessionTimeline: PossessionTimelineEnum.default('ready_to_move'),
    financingMode: z.enum(['bank_loan', 'self_funded', 'undecided']).default('undecided'),
  })
  .refine(
    (data) => data.budgetMinPaise <= data.budgetMaxPaise,
    {
      message: 'budgetMinPaise must not exceed budgetMaxPaise',
      path: ['budgetMinPaise'],
    }
  );
export type RealEstateLeadPreferences = z.infer<typeof RealEstateLeadPreferencesSchema>;
