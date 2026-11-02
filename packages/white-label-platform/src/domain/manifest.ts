/**
 * White-Label Platform Domain — Manifest Schema & Tenant Branding.
 *
 * Implements strict manifest definitions for tenant mobile and web applications
 * under Pravshi OS Blueprint §12. Enforces allowlist validation and zero arbitrary execution.
 */

import { z } from 'zod';

export const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const BUNDLE_ID_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export const ManifestThemeTokensSchema = z.object({
  primaryColor: z.string().regex(HEX_COLOR_REGEX, 'Primary color must be valid hex'),
  secondaryColor: z.string().regex(HEX_COLOR_REGEX, 'Secondary color must be valid hex'),
  accentColor: z.string().regex(HEX_COLOR_REGEX, 'Accent color must be valid hex'),
  backgroundColor: z
    .string()
    .regex(HEX_COLOR_REGEX, 'Background color must be valid hex')
    .default('#ffffff'),
  surfaceColor: z
    .string()
    .regex(HEX_COLOR_REGEX, 'Surface color must be valid hex')
    .default('#f8fafc'),
  textColor: z.string().regex(HEX_COLOR_REGEX, 'Text color must be valid hex').default('#0f172a'),
  borderRadius: z.number().min(0).max(32).default(8),
  fontFamily: z.enum(['system', 'sans-serif', 'serif', 'monospace']).default('system'),
});

export type ManifestThemeTokens = z.infer<typeof ManifestThemeTokensSchema>;

export const WhiteLabelManifestSchema = z.object({
  appName: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-zA-Z0-9\s-_]+$/, 'App name contains illegal characters'),
  shortName: z.string().min(2).max(12),
  bundleId: z
    .string()
    .min(4)
    .max(155)
    .regex(BUNDLE_ID_REGEX, 'Must be a valid reverse-domain bundle identifier'),
  appIcon1024Url: z.string().url('Icon must be a valid HTTPS URL').startsWith('https://'),
  adaptiveIconForegroundUrl: z.string().url().startsWith('https://').optional(),
  adaptiveIconBackgroundHex: z.string().regex(HEX_COLOR_REGEX).optional(),
  splashImageUrl: z.string().url().startsWith('https://'),
  splashBackgroundColor: z.string().regex(HEX_COLOR_REGEX).default('#ffffff'),
  theme: ManifestThemeTokensSchema,
  modules: z.object({
    crmEnabled: z.boolean().default(true),
    realEstateEnabled: z.boolean().default(false),
    educationEnabled: z.boolean().default(false),
    pushNotificationsEnabled: z.boolean().default(true),
  }),
});

export type WhiteLabelManifest = z.infer<typeof WhiteLabelManifestSchema>;

export interface TenantBranding {
  readonly id: string;
  readonly organizationId: string;
  readonly manifest: WhiteLabelManifest;
  readonly version: number;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
