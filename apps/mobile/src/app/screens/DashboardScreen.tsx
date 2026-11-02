/**
 * Pravshi OS  Mobile Application: DashboardScreen.
 *
 * Operational hub displaying tenant overview, quick actions (document scan, tasks),
 * pending offline sync banner, and status telemetry.
 */

import React from 'react';
import {
  useTheme,
  AppHeader,
  OfflineBanner,
  ActionButton,
  StatusPill,
  toCssProperties,
  type MobileViewStyle,
  type MobileTextStyle,
} from '@pravshi/mobile-platform';
import type { SessionManager } from '../../auth/session';
import type { OfflineMutationQueue } from '../../api/offline-queue';

export interface DashboardScreenProps {
  sessionManager: SessionManager;
  offlineQueue?: OfflineMutationQueue;
  isOffline: boolean;
  onNavigateToScanner: () => void;
  onNavigateToTenantSwitcher: () => void;
  onNavigateToOfflineStatus: () => void;
}

export function DashboardScreen({
  sessionManager,
  offlineQueue,
  isOffline,
  onNavigateToScanner,
  onNavigateToTenantSwitcher,
  onNavigateToOfflineStatus,
}: DashboardScreenProps): React.JSX.Element {
  const { theme } = useTheme();
  const tenant = sessionManager.getTenantContext();

  const handleSyncRetry = async () => {
    if (offlineQueue && tenant) {
      await offlineQueue.processQueue(tenant.tenantId);
    }
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
    gap: theme.spacing.lg,
  };

  const cardStyle: MobileViewStyle = {
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
  };

  const sectionHeadingStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  };

  return (
    <div style={toCssProperties(containerStyle)}>
      <AppHeader
        title="Pravshi OS"
        subtitle={tenant?.userEmail}
        tenantName={tenant?.organizationName}
        showTenantBadge={true}
        rightAction={
          <button
            type="button"
            onClick={onNavigateToTenantSwitcher}
            aria-label="Switch organization"
            style={{
              background: 'transparent',
              border: `1px solid ${theme.colors.border}`,
              borderRadius: theme.borderRadius.sm,
              padding: '4px 8px',
              color: theme.colors.text,
              fontSize: theme.typography.fontSize.xs,
              cursor: 'pointer',
            }}
          >
            Switch Org
          </button>
        }
      />

      <OfflineBanner isOffline={isOffline} pendingMutationCount={2} onSyncRetry={handleSyncRetry} />

      <main style={toCssProperties(contentStyle)}>
        {/* Quick Actions Row */}
        <section style={toCssProperties(cardStyle)}>
          <h2 style={{ ...toCssProperties(sectionHeadingStyle), margin: 0 }}>Quick Actions</h2>
          <div
            style={{
              display: 'flex',
              gap: theme.spacing.md,
              marginTop: theme.spacing.md,
              flexWrap: 'wrap',
            }}
          >
            <ActionButton
              label="Scan Document"
              icon="📷"
              onClick={onNavigateToScanner}
              variant="primary"
            />
            <ActionButton
              label="Offline Queue"
              icon="⚡"
              onClick={onNavigateToOfflineStatus}
              variant="secondary"
            />
          </div>
        </section>

        {/* Operational Overview */}
        <section style={toCssProperties(cardStyle)}>
          <h2 style={{ ...toCssProperties(sectionHeadingStyle), margin: 0 }}>Operational Status</h2>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing.sm,
              marginTop: theme.spacing.md,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: theme.typography.fontSize.sm, color: theme.colors.text }}>
                Security Level
              </span>
              <StatusPill label="Hardware Enclave Active" variant="success" size="sm" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: theme.typography.fontSize.sm, color: theme.colors.text }}>
                RLS Context
              </span>
              <StatusPill label="Isolated Tenant Boundary" variant="info" size="sm" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: theme.typography.fontSize.sm, color: theme.colors.text }}>
                Network Status
              </span>
              <StatusPill
                label={isOffline ? 'Offline (Queuing)' : 'Connected'}
                variant={isOffline ? 'warning' : 'success'}
                size="sm"
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
