/**
 * Pravshi OS  Mobile Platform Design Tokens & Dynamic Theming Engine.
 *
 * Implements dynamic theming driven by tenant white-label tokens.
 * Supports light/dark modes, custom tenant palettes, contrast ratio verification,
 * and standard semantic tokens for cross-platform mobile presentation.
 */

import { z } from 'zod';

export const WhiteLabelBrandingSchema = z.object({
  tenantId: z.string().uuid(),
  organizationName: z.string().min(1),
  logoUrl: z.string().url().optional(),
  faviconUrl: z.string().url().optional(),
  primaryColor: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a valid hex color'),
  accentColor: z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a valid hex color')
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a valid hex color')
    .optional(),
  fontFamily: z.string().optional(),
  borderRadiusBase: z.number().nonnegative().default(8),
  supportEmail: z.string().email().optional(),
  privacyPolicyUrl: z.string().url().optional(),
  termsUrl: z.string().url().optional(),
});

export type WhiteLabelBranding = z.infer<typeof WhiteLabelBrandingSchema>;

export interface ColorPalette {
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  background: string;
  surface: string;
  surfaceSubtle: string;
  border: string;
  borderSubtle: string;
  text: string;
  textMuted: string;
  textInverse: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  error: string;
  errorForeground: string;
  info: string;
  infoForeground: string;
  overlay: string;
}

export interface TypographyTokens {
  fontFamily: string;
  fontSize: {
    xs: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    '2xl': number;
    '3xl': number;
  };
  fontWeight: {
    regular: '400';
    medium: '500';
    semibold: '600';
    bold: '700';
  };
  lineHeight: {
    tight: number;
    normal: number;
    relaxed: number;
  };
}

export interface SpacingTokens {
  none: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  '2xl': number;
  '3xl': number;
}

export interface BorderRadiusTokens {
  none: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  full: number;
}

export interface ThemeTokens {
  id: string;
  mode: 'light' | 'dark';
  tenantId?: string;
  colors: ColorPalette;
  typography: TypographyTokens;
  spacing: SpacingTokens;
  borderRadius: BorderRadiusTokens;
}

export const BaseTypographyTokens: TypographyTokens = {
  fontFamily: 'System',
  fontSize: {
    xs: 11,
    sm: 13,
    base: 15,
    lg: 17,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
  },
  fontWeight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.4,
    relaxed: 1.6,
  },
};

export const BaseSpacingTokens: SpacingTokens = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
};

export const DefaultLightTheme: ThemeTokens = {
  id: 'pravshi-light',
  mode: 'light',
  colors: {
    primary: '#0F172A', // Slate 900
    primaryForeground: '#FFFFFF',
    accent: '#2563EB', // Blue 600
    accentForeground: '#FFFFFF',
    background: '#F8FAFC', // Slate 50
    surface: '#FFFFFF',
    surfaceSubtle: '#F1F5F9', // Slate 100
    border: '#E2E8F0', // Slate 200
    borderSubtle: '#F1F5F9',
    text: '#0F172A',
    textMuted: '#64748B', // Slate 500
    textInverse: '#FFFFFF',
    success: '#16A34A', // Green 600
    successForeground: '#FFFFFF',
    warning: '#D97706', // Amber 600
    warningForeground: '#FFFFFF',
    error: '#DC2626', // Red 600
    errorForeground: '#FFFFFF',
    info: '#0284C7', // Sky 600
    infoForeground: '#FFFFFF',
    overlay: 'rgba(15, 23, 42, 0.4)',
  },
  typography: BaseTypographyTokens,
  spacing: BaseSpacingTokens,
  borderRadius: {
    none: 0,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
};

export const DefaultDarkTheme: ThemeTokens = {
  id: 'pravshi-dark',
  mode: 'dark',
  colors: {
    primary: '#F8FAFC', // Slate 50
    primaryForeground: '#0F172A',
    accent: '#3B82F6', // Blue 500
    accentForeground: '#FFFFFF',
    background: '#090D16',
    surface: '#131B2E',
    surfaceSubtle: '#1E293B', // Slate 800
    border: '#283548',
    borderSubtle: '#1E293B',
    text: '#F8FAFC',
    textMuted: '#94A3B8', // Slate 400
    textInverse: '#0F172A',
    success: '#22C55E',
    successForeground: '#0F172A',
    warning: '#F59E0B',
    warningForeground: '#0F172A',
    error: '#EF4444',
    errorForeground: '#FFFFFF',
    info: '#38BDF8',
    infoForeground: '#0F172A',
    overlay: 'rgba(0, 0, 0, 0.7)',
  },
  typography: BaseTypographyTokens,
  spacing: BaseSpacingTokens,
  borderRadius: {
    none: 0,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
};

/**
 * Calculates accessible contrast foreground color (either black or white) for a given hex color.
 */
export function getAccessibleForeground(hexColor: string): string {
  const cleanHex = hexColor.replace('#', '');
  const r = parseInt(
    cleanHex.length === 3 ? cleanHex[0]! + cleanHex[0]! : cleanHex.substring(0, 2),
    16,
  );
  const g = parseInt(
    cleanHex.length === 3 ? cleanHex[1]! + cleanHex[1]! : cleanHex.substring(2, 4),
    16,
  );
  const b = parseInt(
    cleanHex.length === 3 ? cleanHex[2]! + cleanHex[2]! : cleanHex.substring(4, 6),
    16,
  );

  // YIQ luminance formula
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#0F172A' : '#FFFFFF';
}

/**
 * Resolves dynamic theme tokens by applying tenant white-label branding overrides.
 */
export function resolveTenantTheme(
  branding?: WhiteLabelBranding | null,
  mode: 'light' | 'dark' = 'light',
): ThemeTokens {
  const baseTheme = mode === 'dark' ? DefaultDarkTheme : DefaultLightTheme;

  if (!branding) {
    return baseTheme;
  }

  const primaryForeground = getAccessibleForeground(branding.primaryColor);
  const accentColor = branding.accentColor ?? (mode === 'dark' ? '#3B82F6' : '#2563EB');
  const accentForeground = getAccessibleForeground(accentColor);
  const baseRadius = branding.borderRadiusBase ?? 8;

  return {
    ...baseTheme,
    id: `tenant-${branding.tenantId}-${mode}`,
    tenantId: branding.tenantId,
    colors: {
      ...baseTheme.colors,
      primary: branding.primaryColor,
      primaryForeground,
      accent: accentColor,
      accentForeground,
    },
    typography: {
      ...baseTheme.typography,
      fontFamily: branding.fontFamily ?? baseTheme.typography.fontFamily,
    },
    borderRadius: {
      none: 0,
      sm: Math.max(2, Math.round(baseRadius * 0.5)),
      md: baseRadius,
      lg: Math.round(baseRadius * 1.5),
      xl: Math.round(baseRadius * 2),
      full: 9999,
    },
  };
}
