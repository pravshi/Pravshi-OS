/**
 * Application Use Case — Compile Theme Tokens.
 *
 * Compiles tenant manifest branding data into immutable, typed design tokens
 * for React Native and web style runtimes.
 */

import type { WhiteLabelManifest } from '../domain/manifest';

export interface CompiledThemeTokens {
  readonly colors: {
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
    readonly background: string;
    readonly surface: string;
    readonly text: string;
  };
  readonly spacing: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
  };
  readonly borderRadius: {
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly full: number;
  };
  readonly typography: {
    readonly fontFamily: string;
  };
  readonly cssVariables: Record<string, string>;
}

export function compileThemeTokens(manifest: WhiteLabelManifest): CompiledThemeTokens {
  const theme = manifest.theme;

  const colors = {
    primary: theme.primaryColor,
    secondary: theme.secondaryColor,
    accent: theme.accentColor,
    background: theme.backgroundColor,
    surface: theme.surfaceColor,
    text: theme.textColor,
  };

  const borderRadius = {
    sm: Math.max(2, Math.round(theme.borderRadius / 2)),
    md: theme.borderRadius,
    lg: theme.borderRadius * 2,
    full: 9999,
  };

  const cssVariables: Record<string, string> = {
    '--pravshi-color-primary': colors.primary,
    '--pravshi-color-secondary': colors.secondary,
    '--pravshi-color-accent': colors.accent,
    '--pravshi-color-bg': colors.background,
    '--pravshi-color-surface': colors.surface,
    '--pravshi-color-text': colors.text,
    '--pravshi-border-radius': `${borderRadius.md}px`,
  };

  return {
    colors,
    spacing: {
      xs: 4,
      sm: 8,
      md: 16,
      lg: 24,
      xl: 32,
    },
    borderRadius,
    typography: {
      fontFamily: theme.fontFamily,
    },
    cssVariables,
  };
}
