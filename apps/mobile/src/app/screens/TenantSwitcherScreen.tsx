/**
 * Pravshi OS  Mobile Application: TenantSwitcherScreen.
 *
 * Allows authenticated multi-tenant users to switch active tenant organizations.
 * Ensures local caches are cleanly partitioned and re-authentication is enforced.
 */

import React, { useState } from 'react';
import {
  useTheme,
  AppHeader,
  ActionButton,
  toCssProperties,
  type MobileViewStyle,
  type MobileTextStyle,
} from '@pravshi/mobile-platform';
import type { SessionManager } from '../../auth/session';

export interface TenantOption {
  id: string;
  name: string;
  slug: string;
  role: string;
  isCurrent: boolean;
}

export interface TenantSwitcherScreenProps {
  sessionManager: SessionManager;
  onSelectTenant: (tenantId: string) => void;
  onBack: () => void;
}

export function TenantSwitcherScreen({
  sessionManager,
  onSelectTenant,
  onBack,
}: TenantSwitcherScreenProps): React.JSX.Element {
  const { theme } = useTheme();
  const activeTenant = sessionManager.getTenantContext();

  // Mock list of organizations provisioned for this user
  const [tenants] = useState<TenantOption[]>([
    {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Acme Corporation',
      slug: 'acme',
      role: 'ADMIN',
      isCurrent: activeTenant?.tenantId === '00000000-0000-0000-0000-000000000001',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Globex Holdings',
      slug: 'globex',
      role: 'EMPLOYEE',
      isCurrent: activeTenant?.tenantId === '00000000-0000-0000-0000-000000000002',
    },
  ]);

  const handleSwitch = async (tenantId: string) => {
    await sessionManager.switchTenant(tenantId);
    onSelectTenant(tenantId);
  };

  const containerStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: theme.colors.background,
    minHeight: '100%',
    width: '100%',
  };

  const contentStyle: MobileViewStyle = {
    padding: theme.spacing.lg,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing.md,
  };

  const cardStyle = (isCurrent: boolean): MobileViewStyle => ({
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing.lg,
    backgroundColor: isCurrent ? theme.colors.surfaceSubtle : theme.colors.surface,
    borderColor: isCurrent ? theme.colors.accent : theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
  });

  const tenantNameStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text,
  };

  const tenantRoleStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  };

  return (
    <div style={toCssProperties(containerStyle)}>
      <AppHeader
        title="Switch Organization"
        subtitle="Select active tenant context"
        onBack={onBack}
        showTenantBadge={false}
      />

      <main style={toCssProperties(contentStyle)}>
        <p
          style={{
            fontSize: theme.typography.fontSize.sm,
            color: theme.colors.textMuted,
            margin: 0,
          }}
        >
          Each organization maintains an isolated security context and hardware-backed session key.
        </p>

        {tenants.map((t) => (
          <div key={t.id} style={toCssProperties(cardStyle(t.isCurrent))}>
            <div>
              <div style={toCssProperties(tenantNameStyle)}>{t.name}</div>
              <div style={toCssProperties(tenantRoleStyle)}>
                {t.slug} • Role: {t.role}
              </div>
            </div>

            {t.isCurrent ? (
              <span
                style={{
                  fontSize: theme.typography.fontSize.xs,
                  fontWeight: 600,
                  color: theme.colors.success,
                  padding: '4px 8px',
                  backgroundColor: 'rgba(34, 197, 94, 0.1)',
                  borderRadius: theme.borderRadius.sm,
                }}
              >
                Active
              </span>
            ) : (
              <ActionButton
                label="Switch"
                size="sm"
                variant="outline"
                onClick={() => handleSwitch(t.id)}
              />
            )}
          </div>
        ))}
      </main>
    </div>
  );
}
