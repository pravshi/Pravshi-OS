/**
 * Pravshi OS  Mobile Platform: ActionButton Component.
 *
 * Theme-aware, accessible button supporting primary, secondary, outline,
 * and destructive variants, loading state, and offline status.
 */

import React, { type ReactNode } from 'react';
import { useTheme } from '../theme-context';
import { toCssProperties, type MobileViewStyle, type MobileTextStyle } from '../primitives';

export type ActionButtonVariant = 'primary' | 'secondary' | 'outline' | 'destructive' | 'ghost';

export interface ActionButtonProps {
  label: string;
  onClick: () => void;
  variant?: ActionButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  fullWidth?: boolean;
  style?: MobileViewStyle;
}

export function ActionButton({
  label,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  fullWidth = false,
  style,
}: ActionButtonProps): React.JSX.Element {
  const { theme } = useTheme();

  const getVariantStyles = (): { bg: string; text: string; border: string } => {
    switch (variant) {
      case 'secondary':
        return {
          bg: theme.colors.surfaceSubtle,
          text: theme.colors.text,
          border: theme.colors.border,
        };
      case 'outline':
        return {
          bg: 'transparent',
          text: theme.colors.primary,
          border: theme.colors.primary,
        };
      case 'destructive':
        return {
          bg: theme.colors.error,
          text: theme.colors.errorForeground,
          border: theme.colors.error,
        };
      case 'ghost':
        return {
          bg: 'transparent',
          text: theme.colors.text,
          border: 'transparent',
        };
      case 'primary':
      default:
        return {
          bg: theme.colors.primary,
          text: theme.colors.primaryForeground,
          border: theme.colors.primary,
        };
    }
  };

  const { bg, text, border } = getVariantStyles();

  const getPadding = () => {
    switch (size) {
      case 'sm':
        return {
          px: theme.spacing.md,
          py: theme.spacing.xs,
          fontSize: theme.typography.fontSize.sm,
        };
      case 'lg':
        return {
          px: theme.spacing.xl,
          py: theme.spacing.md,
          fontSize: theme.typography.fontSize.lg,
        };
      case 'md':
      default:
        return {
          px: theme.spacing.lg,
          py: theme.spacing.sm,
          fontSize: theme.typography.fontSize.base,
        };
    }
  };

  const { px, py, fontSize } = getPadding();

  const isDisabled = disabled || loading;

  const buttonStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: px,
    paddingVertical: py,
    backgroundColor: isDisabled ? theme.colors.surfaceSubtle : bg,
    borderColor: isDisabled ? theme.colors.borderSubtle : border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    opacity: isDisabled ? 0.6 : 1,
    width: fullWidth ? '100%' : 'auto',
    ...style,
  };

  const textStyle: MobileTextStyle = {
    color: isDisabled ? theme.colors.textMuted : text,
    fontSize,
    fontWeight: theme.typography.fontWeight.semibold,
    textAlign: 'center',
  };

  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      style={{
        ...toCssProperties(buttonStyle),
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        borderStyle: 'solid',
      }}
    >
      {loading ? (
        <span
          style={{
            ...toCssProperties(textStyle),
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ animation: 'spin 1s linear infinite' }}>⏳</span>
          Loading...
        </span>
      ) : (
        <span
          style={{
            ...toCssProperties(textStyle),
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {icon && <span>{icon}</span>}
          {label}
        </span>
      )}
    </button>
  );
}
