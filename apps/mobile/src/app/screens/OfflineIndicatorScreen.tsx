/**
 * Pravshi OS  Mobile Application: OfflineIndicatorScreen.
 *
 * Detailed offline status inspector displaying queued mutations,
 * network connectivity telemetry, and manual replay actions.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  useTheme,
  AppHeader,
  ActionButton,
  StatusPill,
  toCssProperties,
  type MobileViewStyle,
  type MobileTextStyle,
} from '@pravshi/mobile-platform';
import type { OfflineMutationQueue, QueuedMutation } from '../../api/offline-queue';

export interface OfflineIndicatorScreenProps {
  tenantId: string;
  offlineQueue: OfflineMutationQueue;
  isOffline: boolean;
  onBack: () => void;
}

export function OfflineIndicatorScreen({
  tenantId,
  offlineQueue,
  isOffline,
  onBack,
}: OfflineIndicatorScreenProps): React.JSX.Element {
  const { theme } = useTheme();
  const [queue, setQueue] = useState<QueuedMutation[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const loadQueue = useCallback(async () => {
    const items = await offlineQueue.getQueue(tenantId);
    setQueue(items);
  }, [tenantId, offlineQueue]);

  useEffect(() => {
    loadQueue();
    const unsubscribe = offlineQueue.subscribe(() => {
      loadQueue();
    });
    return unsubscribe;
  }, [loadQueue, offlineQueue]);

  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      await offlineQueue.processQueue(tenantId);
      await loadQueue();
    } finally {
      setIsSyncing(false);
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
    gap: theme.spacing.md,
  };

  const cardStyle: MobileViewStyle = {
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
  };

  const headingStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text,
  };

  return (
    <div style={toCssProperties(containerStyle)}>
      <AppHeader
        title="Offline Sync Queue"
        subtitle={`${queue.length} pending mutation(s)`}
        onBack={onBack}
        showTenantBadge={false}
      />

      <main style={toCssProperties(contentStyle)}>
        {/* Network status overview */}
        <div style={toCssProperties(cardStyle)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={toCssProperties(headingStyle)}>Connection Status</div>
              <div
                style={{
                  fontSize: theme.typography.fontSize.xs,
                  color: theme.colors.textMuted,
                  marginTop: 2,
                }}
              >
                {isOffline
                  ? 'Device is offline. Changes are saved locally.'
                  : 'Connected to Pravshi OS API.'}
              </div>
            </div>
            <StatusPill
              label={isOffline ? 'Offline' : 'Online'}
              variant={isOffline ? 'warning' : 'success'}
            />
          </div>

          {!isOffline && queue.length > 0 && (
            <div style={{ marginTop: theme.spacing.md }}>
              <ActionButton
                label="Process Queue Now"
                onClick={handleSyncNow}
                loading={isSyncing}
                variant="primary"
                fullWidth
              />
            </div>
          )}
        </div>

        {/* Queued Mutations List */}
        <div style={toCssProperties(cardStyle)}>
          <div style={toCssProperties(headingStyle)}>Pending Mutations</div>
          {queue.length === 0 ? (
            <p
              style={{
                fontSize: theme.typography.fontSize.sm,
                color: theme.colors.textMuted,
                marginTop: theme.spacing.sm,
              }}
            >
              All offline actions have been synced to the server.
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: theme.spacing.sm,
                marginTop: theme.spacing.md,
              }}
            >
              {queue.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: theme.spacing.sm,
                    backgroundColor: theme.colors.surfaceSubtle,
                    borderRadius: theme.borderRadius.sm,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: theme.typography.fontSize.xs,
                        color: theme.colors.accent,
                      }}
                    >
                      {item.method}
                    </span>{' '}
                    <span
                      style={{ fontSize: theme.typography.fontSize.xs, color: theme.colors.text }}
                    >
                      {item.endpoint}
                    </span>
                    <div style={{ fontSize: 10, color: theme.colors.textMuted }}>
                      Entity: {item.entityType} • Retries: {item.retryCount}
                    </div>
                  </div>
                  <StatusPill label="Queued" variant="muted" size="sm" />
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
