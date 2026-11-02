/**
 * Pravshi OS  Mobile Platform: AppHeader Component.
 *
 * Header displaying tenant branding, active screen title, navigation back/menu triggers,
 * and tenant context status.
 */

import React, { type ReactNode } from 'react';
import { useTheme } from '../theme-context';
import { TenantBadge } from './TenantBadge';
import { toCssProperties, type MobileViewStyle, type MobileTextStyle } from '../primitives';

export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  showTenantBadge?: boolean;
  tenantName?: string;
  onBack?: () => void;
  rightAction?: ReactNode;
  style?: MobileViewStyle;
}

export function AppHeader({
  title,
  subtitle,
  showTenantBadge = true,
  tenantName,
  onBack,
  rightAction,
  style,
}: AppHeaderProps): React.JSX.Element {
  const { theme, branding } = useTheme();

  const containerStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    minHeight: 56,
    ...style,
  };

  const titleStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text,
  };

  const subtitleStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  };

  const resolvedTenantName = tenantName ?? branding?.organizationName;

  return (
    <header
      style={toCssProperties(containerStyle)}
      role="banner"
      data-tenant-id={theme.tenantId ?? 'default'}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Go back"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: theme.colors.text,
              fontSize: 18,
              padding: 4,
            }}
          >
            ←
          </button>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h1 style={{ ...toCssProperties(titleStyle), margin: 0 }}>{title}</h1>
          {subtitle && (
            <span style={{ ...toCssProperties(subtitleStyle), marginTop: 2 }}>{subtitle}</span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
        {showTenantBadge && resolvedTenantName && (
          <TenantBadge tenantName={resolvedTenantName} size="sm" />
        )}
        {rightAction}
      </div>
    </header>
  );
}
