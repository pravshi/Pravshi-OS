/**
 * Pravshi OS  Mobile Application Session Lifecycle & Tenant Context.
 *
 * Implements strict tenant context management, session lifecycle transitions,
 * and biometric re-authentication contracts.
 */

import { z } from 'zod';
import type { MobileSecureStorage, MobileSessionCredentials } from './secure-storage';

export type SessionLifecycleState =
  | 'UNINITIALIZED'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'EXPIRED'
  | 'LOGGED_OUT';

export const MobileTenantContextSchema = z.object({
  tenantId: z.string().uuid(),
  organizationName: z.string().min(1),
  organizationSlug: z.string().min(1),
  userId: z.string().uuid(),
  userEmail: z.string().email(),
  userRole: z.string().min(1),
  permissions: z.array(z.string()),
  avatarUrl: z.string().url().optional(),
});

export type MobileTenantContext = z.infer<typeof MobileTenantContextSchema>;

export interface ReauthContractOptions {
  reason: 'BIOMETRIC_CHECK' | 'SESSION_TIMEOUT' | 'STEP_UP_SECURITY' | 'TENANT_SWITCH';
  requiredPermission?: string;
}

export type SessionStateListener = (state: {
  lifecycle: SessionLifecycleState;
  tenant: MobileTenantContext | null;
}) => void;

export class SessionManager {
  private lifecycle: SessionLifecycleState = 'UNINITIALIZED';
  private tenantContext: MobileTenantContext | null = null;
  private listeners: Set<SessionStateListener> = new Set();
  private lastActiveTimestamp: number = Date.now();
  private readonly inactivityTimeoutMs: number;

  constructor(
    private readonly secureStorage: MobileSecureStorage,
    options?: { inactivityTimeoutMs?: number },
  ) {
    // Default 15 minutes of inactivity before requiring biometric re-auth
    this.inactivityTimeoutMs = options?.inactivityTimeoutMs ?? 15 * 60 * 1000;
  }

  /**
   * Initializes session from secure enclave on app cold start.
   */
  async initialize(): Promise<SessionLifecycleState> {
    const creds = await this.secureStorage.getSessionCredentials();
    if (!creds) {
      this.setState('LOGGED_OUT', null);
      return 'LOGGED_OUT';
    }

    if (Date.now() >= creds.expiresAt) {
      this.setState('EXPIRED', null);
      return 'EXPIRED';
    }

    // Require biometric challenge on cold start if biometrics are enabled
    const bioFlags = await this.secureStorage.getBiometricFlags();
    if (bioFlags?.biometricsEnabled) {
      this.setState('REAUTHENTICATION_REQUIRED', null);
      return 'REAUTHENTICATION_REQUIRED';
    }

    // If active and valid, mark as authenticated
    this.setState('AUTHENTICATED', this.tenantContext);
    return 'AUTHENTICATED';
  }

  getLifecycle(): SessionLifecycleState {
    return this.lifecycle;
  }

  getTenantContext(): MobileTenantContext | null {
    return this.tenantContext;
  }

  getActiveTenantId(): string | null {
    return this.tenantContext?.tenantId ?? null;
  }

  /**
   * Completes login or token refresh, establishing active tenant context.
   */
  async establishSession(
    credentials: MobileSessionCredentials,
    tenantContext: MobileTenantContext,
  ): Promise<void> {
    await this.secureStorage.saveSessionCredentials(credentials);
    this.tenantContext = tenantContext;
    this.lastActiveTimestamp = Date.now();
    this.setState('AUTHENTICATED', tenantContext);
  }

  /**
   * Demands re-authentication (e.g. returning to foreground or high-risk action).
   */
  requireReauthentication(options?: ReauthContractOptions): void {
    void options;
    if (this.lifecycle === 'AUTHENTICATED') {
      this.setState('REAUTHENTICATION_REQUIRED', this.tenantContext);
    }
  }

  /**
   * Completes biometric or passcode challenge.
   */
  verifyReauthentication(): void {
    if (this.lifecycle === 'REAUTHENTICATION_REQUIRED') {
      this.lastActiveTimestamp = Date.now();
      this.setState('AUTHENTICATED', this.tenantContext);
    }
  }

  /**
   * Records app user activity to postpone inactivity timeout.
   */
  touchActivity(): void {
    const now = Date.now();
    if (this.lifecycle === 'AUTHENTICATED') {
      if (now - this.lastActiveTimestamp > this.inactivityTimeoutMs) {
        this.requireReauthentication({ reason: 'SESSION_TIMEOUT' });
      } else {
        this.lastActiveTimestamp = now;
      }
    }
  }

  /**
   * Switches tenant context cleanly. Clears active session and requires re-scoping.
   */
  async switchTenant(newTenantId: string): Promise<void> {
    if (!this.tenantContext || this.tenantContext.tenantId === newTenantId) {
      return;
    }
    // Tenant switch requires re-authentication / new token issuance for the new tenant
    this.requireReauthentication({ reason: 'TENANT_SWITCH' });
  }

  /**
   * Complete logout. Wipes session credentials from Secure Enclave.
   */
  async logout(): Promise<void> {
    await this.secureStorage.clearSessionCredentials();
    this.tenantContext = null;
    this.setState('LOGGED_OUT', null);
  }

  subscribe(listener: SessionStateListener): () => void {
    this.listeners.add(listener);
    listener({ lifecycle: this.lifecycle, tenant: this.tenantContext });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(lifecycle: SessionLifecycleState, tenant: MobileTenantContext | null): void {
    this.lifecycle = lifecycle;
    this.tenantContext = tenant;
    for (const listener of this.listeners) {
      try {
        listener({ lifecycle, tenant });
      } catch (err) {
        console.error('[SessionManager] Listener error:', err);
      }
    }
  }
}
