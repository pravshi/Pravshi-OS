/**
 * Pravshi OS  Mobile Platform: OfflineBanner Component.
 *
 * Displays connectivity status, pending offline mutation queue size,
 * and sync retry triggers.
 */

import React from 'react';
import { useTheme } from '../theme-context';
import { toCssProperties, type MobileViewStyle, type MobileTextStyle } from '../primitives';

export interface OfflineBannerProps {
  isOffline: boolean;
  pendingMutationCount?: number;
  onSyncRetry?: () => void;
  isSyncing?: boolean;
  style?: MobileViewStyle;
}

export function OfflineBanner({
  isOffline,
  pendingMutationCount = 0,
  onSyncRetry,
  isSyncing = false,
  style,
}: OfflineBannerProps): React.JSX.Element | null {
  const { theme } = useTheme();

  // If online and nothing pending, banner is hidden
  if (!isOffline && pendingMutationCount === 0 && !isSyncing) {
    return null;
  }

  const containerStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: isOffline ? theme.colors.warning : theme.colors.accent,
    borderRadius: 0,
    ...style,
  };

  const textStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: isOffline ? theme.colors.warningForeground : theme.colors.accentForeground,
  };

  const message = isOffline
    ? `You are offline. ${pendingMutationCount > 0 ? `${pendingMutationCount} action(s) queued.` : 'Changes will sync once connected.'}`
    : isSyncing
      ? `Syncing ${pendingMutationCount} queued action(s)...`
      : `${pendingMutationCount} queued action(s) ready to sync.`;

  return (
    <aside style={toCssProperties(containerStyle)} role="alert" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing.xs }}>
        <span style={{ fontSize: 16 }}>{isOffline ? '⚡' : '🔄'}</span>
        <span style={toCssProperties(textStyle)}>{message}</span>
      </div>

      {!isOffline && onSyncRetry && (
        <button
          type="button"
          onClick={onSyncRetry}
          disabled={isSyncing}
          style={{
            background: 'rgba(255, 255, 255, 0.2)',
            border: 'none',
            borderRadius: theme.borderRadius.sm,
            padding: '4px 8px',
            color: '#FFFFFF',
            fontSize: theme.typography.fontSize.xs,
            fontWeight: 600,
            cursor: isSyncing ? 'not-allowed' : 'pointer',
          }}
        >
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </button>
      )}
    </aside>
  );
}
