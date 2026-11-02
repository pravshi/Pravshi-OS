/**
 * Pravshi OS  Mobile Application Secure Storage Interface.
 *
 * Implements hardware-backed secure storage for sensitive authentication tokens
 * and device signing keys using the OS Secure Enclave (Apple Keychain / Android Keystore).
 *
 * CRITICAL SECURITY INVARIANT:
 * Session tokens, refresh tokens, and HMAC signing key seeds MUST NEVER be stored
 * in unencrypted AsyncStorage, local state, or client-side SQLite databases.
 */

import type { ISecureEnclaveStorage, EnclaveStorageOptions } from '@pravshi/mobile-platform';

export interface MobileSessionCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tenantId: string;
  userId: string;
  signingKeySeed?: string;
}

export interface BiometricAuthFlags {
  biometricsEnabled: boolean;
  enrolledAt?: number;
  lastVerifiedAt?: number;
}

const SECURE_KEYS = {
  SESSION_CREDENTIALS: 'auth.session.credentials',
  BIOMETRICS_FLAG: 'auth.biometric_token.flags',
  DEVICE_SIGNING_KEY: 'auth.device_signing_key.seed',
} as const;

export class MobileSecureStorage {
  constructor(private readonly enclave: ISecureEnclaveStorage) {}

  /**
   * Persists session credentials strictly into the hardware secure enclave.
   */
  async saveSessionCredentials(
    credentials: MobileSessionCredentials,
    options?: EnclaveStorageOptions,
  ): Promise<void> {
    if (!credentials.accessToken || !credentials.refreshToken) {
      throw new Error('Cannot store empty session credentials in secure storage');
    }

    const serialized = JSON.stringify(credentials);
    await this.enclave.setItem(SECURE_KEYS.SESSION_CREDENTIALS, serialized, {
      accessible: 'after_first_unlock',
      ...options,
    });
  }

  /**
   * Retrieves active session credentials from secure storage.
   */
  async getSessionCredentials(): Promise<MobileSessionCredentials | null> {
    const raw = await this.enclave.getItem(SECURE_KEYS.SESSION_CREDENTIALS);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed.accessToken || !parsed.tenantId) {
        return null;
      }
      return parsed as MobileSessionCredentials;
    } catch {
      await this.enclave.removeItem(SECURE_KEYS.SESSION_CREDENTIALS);
      return null;
    }
  }

  /**
   * Clears session credentials upon logout or tenant offboarding.
   */
  async clearSessionCredentials(): Promise<void> {
    await this.enclave.removeItem(SECURE_KEYS.SESSION_CREDENTIALS);
  }

  /**
   * Saves or updates device signing key seed for client-side mutation signing.
   */
  async saveDeviceSigningKey(seed: string): Promise<void> {
    await this.enclave.setItem(SECURE_KEYS.DEVICE_SIGNING_KEY, seed, {
      accessible: 'device_only',
    });
  }

  /**
   * Retrieves device signing key seed.
   */
  async getDeviceSigningKey(): Promise<string | null> {
    return this.enclave.getItem(SECURE_KEYS.DEVICE_SIGNING_KEY);
  }

  /**
   * Configures biometric prompt flags.
   */
  async setBiometricFlags(flags: BiometricAuthFlags): Promise<void> {
    await this.enclave.setItem(SECURE_KEYS.BIOMETRICS_FLAG, JSON.stringify(flags), {
      accessible: 'after_first_unlock',
    });
  }

  /**
   * Retrieves biometric prompt flags.
   */
  async getBiometricFlags(): Promise<BiometricAuthFlags | null> {
    const raw = await this.enclave.getItem(SECURE_KEYS.BIOMETRICS_FLAG);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BiometricAuthFlags;
    } catch {
      return null;
    }
  }

  /**
   * Complete wipe of all secure credentials on device (e.g. account deletion / factory reset).
   */
  async wipeAllSecureStorage(): Promise<void> {
    await this.enclave.clearAllSecureCredentials();
  }
}
