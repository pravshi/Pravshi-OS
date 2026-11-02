/**
 * Pravshi OS  Mobile Platform: TenantBadge Component.
 *
 * Displays the current tenant organization name, security boundary indicator,
 * and environment mode.
 */

import React from 'react';
import { useTheme } from '../theme-context';
import { toCssProperties, type MobileViewStyle, type MobileTextStyle } from '../primitives';

export interface TenantBadgeProps {
  tenantName: string;
  tenantSlug?: string;
  size?: 'sm' | 'md';
  isIsolated?: boolean;
  onClick?: () => void;
  style?: MobileViewStyle;
}

export function TenantBadge({
  tenantName,
  tenantSlug,
  size = 'md',
  isIsolated = true,
  onClick,
  style,
}: TenantBadgeProps): React.JSX.Element {
  const { theme } = useTheme();

  const isSmall = size === 'sm';

  const badgeStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: isSmall ? theme.spacing.sm : theme.spacing.md,
    paddingVertical: isSmall ? 2 : theme.spacing.xs,
    backgroundColor: theme.colors.surfaceSubtle,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.full,
    ...style,
  };

  const textStyle: MobileTextStyle = {
    fontSize: isSmall ? theme.typography.fontSize.xs : theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: theme.colors.text,
  };

  const dotColor = isIsolated ? theme.colors.success : theme.colors.warning;

  const content = (
    <div
      style={{
        ...toCssProperties(badgeStyle),
        cursor: onClick ? 'pointer' : 'default',
        userSelect: 'none',
      }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={isIsolated ? `Tenant: ${tenantName} (Strict Tenant Isolation Enforced)` : tenantName}
    >
      <span
        style={{
          width: isSmall ? 6 : 8,
          height: isSmall ? 6 : 8,
          borderRadius: 9999,
          backgroundColor: dotColor,
          marginRight: theme.spacing.xs,
          display: 'inline-block',
        }}
      />
      <span style={toCssProperties(textStyle)}>
        {tenantName}
        {tenantSlug && <span style={{ opacity: 0.6, marginLeft: 4 }}>({tenantSlug})</span>}
      </span>
    </div>
  );

  return content;
}
