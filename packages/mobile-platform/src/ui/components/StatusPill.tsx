/**
 * Pravshi OS  Mobile Platform: StatusPill Component.
 *
 * Status indicator with semantic color variants for CRM records,
 * tasks, workflow states, and system events.
 */

import React from 'react';
import { useTheme } from '../theme-context';
import { toCssProperties, type MobileViewStyle, type MobileTextStyle } from '../primitives';

export type StatusVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'muted';

export interface StatusPillProps {
  label: string;
  variant?: StatusVariant;
  size?: 'sm' | 'md';
  style?: MobileViewStyle;
}

export function StatusPill({
  label,
  variant = 'default',
  size = 'md',
  style,
}: StatusPillProps): React.JSX.Element {
  const { theme } = useTheme();

  const isSmall = size === 'sm';

  const getVariantColors = (): { bg: string; text: string; border: string } => {
    switch (variant) {
      case 'success':
        return {
          bg: theme.mode === 'dark' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(22, 163, 74, 0.1)',
          text: theme.colors.success,
          border: theme.colors.success,
        };
      case 'warning':
        return {
          bg: theme.mode === 'dark' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(217, 119, 6, 0.1)',
          text: theme.colors.warning,
          border: theme.colors.warning,
        };
      case 'error':
        return {
          bg: theme.mode === 'dark' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(220, 38, 38, 0.1)',
          text: theme.colors.error,
          border: theme.colors.error,
        };
      case 'info':
        return {
          bg: theme.mode === 'dark' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(2, 132, 199, 0.1)',
          text: theme.colors.info,
          border: theme.colors.info,
        };
      case 'muted':
        return {
          bg: theme.colors.surfaceSubtle,
          text: theme.colors.textMuted,
          border: theme.colors.borderSubtle,
        };
      case 'default':
      default:
        return {
          bg: theme.colors.surfaceSubtle,
          text: theme.colors.text,
          border: theme.colors.border,
        };
    }
  };

  const { bg, text, border } = getVariantColors();

  const containerStyle: MobileViewStyle = {
    display: 'inline-flex',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: isSmall ? theme.spacing.sm : theme.spacing.md,
    paddingVertical: isSmall ? 2 : 4,
    backgroundColor: bg,
    borderColor: border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.full,
    ...style,
  };

  const textStyle: MobileTextStyle = {
    fontSize: isSmall ? theme.typography.fontSize.xs : theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: text,
    textAlign: 'center',
  };

  return (
    <span style={toCssProperties(containerStyle)}>
      <span style={toCssProperties(textStyle)}>{label}</span>
    </span>
  );
}
