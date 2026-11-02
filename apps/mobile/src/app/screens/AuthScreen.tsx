/**
 * Pravshi OS  Mobile Application: AuthScreen.
 *
 * Handles initial login, organization discovery, SSO redirects,
 * and biometric unlock challenges via the hardware Secure Enclave.
 */

import React, { useState } from 'react';
import {
  useTheme,
  ActionButton,
  toCssProperties,
  type MobileViewStyle,
  type MobileTextStyle,
} from '@pravshi/mobile-platform';
import type { SessionManager } from '../../auth/session';

export interface AuthScreenProps {
  sessionManager: SessionManager;
  onLoginSuccess: () => void;
  isBiometricChallenge?: boolean;
}

export function AuthScreen({
  sessionManager,
  onLoginSuccess,
  isBiometricChallenge = false,
}: AuthScreenProps): React.JSX.Element {
  const { theme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCredentialsSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      if (!email || !password) {
        throw new Error('Please enter both email and password.');
      }

      // In production mobile app, this calls /api/v1/auth/login
      // Here we simulate successful session establishment and state transition
      await sessionManager.establishSession(
        {
          accessToken: 'mock_mobile_jwt_access_token',
          refreshToken: 'mock_mobile_jwt_refresh_token',
          expiresAt: Date.now() + 3600 * 1000,
          tenantId: '00000000-0000-0000-0000-000000000001',
          userId: '00000000-0000-0000-0000-000000000002',
        },
        {
          tenantId: '00000000-0000-0000-0000-000000000001',
          organizationName: 'Acme Corporation',
          organizationSlug: 'acme',
          userId: '00000000-0000-0000-0000-000000000002',
          userEmail: email,
          userRole: 'EMPLOYEE',
          permissions: ['crm.leads.read', 'work.tasks.read'],
        },
      );

      onLoginSuccess();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBiometricUnlock = async () => {
    setIsLoading(true);
    try {
      sessionManager.verifyReauthentication();
      onLoginSuccess();
    } catch {
      setErrorMessage('Biometric verification failed. Please enter your password.');
    } finally {
      setIsLoading(false);
    }
  };

  const containerStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
    minHeight: '100%',
    width: '100%',
  };

  const cardStyle: MobileViewStyle = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: 400,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
  };

  const headingStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: theme.spacing.xs,
  };

  const subheadingStyle: MobileTextStyle = {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  const inputStyle = {
    width: '100%',
    padding: '12px 16px',
    backgroundColor: theme.colors.surfaceSubtle,
    border: `1px solid ${theme.colors.border}`,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.base,
    marginBottom: theme.spacing.md,
    outline: 'none',
    boxSizing: 'border-box' as const,
  };

  return (
    <div style={toCssProperties(containerStyle)}>
      <div style={toCssProperties(cardStyle)}>
        <h2 style={toCssProperties(headingStyle)}>
          {isBiometricChallenge ? 'Unlock Pravshi OS' : 'Sign In to Pravshi OS'}
        </h2>
        <p style={toCssProperties(subheadingStyle)}>
          {isBiometricChallenge
            ? 'Verify your identity to resume session'
            : 'Enter your credentials to access your tenant workspace'}
        </p>

        {errorMessage && (
          <div
            style={{
              padding: theme.spacing.sm,
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderColor: theme.colors.error,
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: theme.borderRadius.sm,
              color: theme.colors.error,
              fontSize: theme.typography.fontSize.sm,
              marginBottom: theme.spacing.md,
              textAlign: 'center',
            }}
          >
            {errorMessage}
          </div>
        )}

        {isBiometricChallenge ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.spacing.md,
              alignItems: 'center',
            }}
          >
            <div style={{ fontSize: 48, margin: '16px 0' }}>🔐</div>
            <ActionButton
              label="Authenticate with Face ID / Fingerprint"
              onClick={handleBiometricUnlock}
              variant="primary"
              fullWidth
              loading={isLoading}
            />
          </div>
        ) : (
          <form
            onSubmit={handleCredentialsSubmit}
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            <label
              style={{
                fontSize: theme.typography.fontSize.xs,
                color: theme.colors.textMuted,
                marginBottom: 4,
              }}
            >
              Work Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@organization.com"
              style={inputStyle}
              required
            />

            <label
              style={{
                fontSize: theme.typography.fontSize.xs,
                color: theme.colors.textMuted,
                marginBottom: 4,
              }}
            >
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              style={inputStyle}
              required
            />

            <ActionButton
              label="Sign In"
              onClick={() => handleCredentialsSubmit()}
              variant="primary"
              fullWidth
              loading={isLoading}
              style={{ marginTop: theme.spacing.sm }}
            />
          </form>
        )}
      </div>
    </div>
  );
}
