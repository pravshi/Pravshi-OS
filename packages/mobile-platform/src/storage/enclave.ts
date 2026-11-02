/**
 * Pravshi OS  Mobile Platform Secure Enclave Storage Adapter.
 *
 * Provides base abstractions and verification for hardware-backed secure storage.
 * In production native builds, this delegates to expo-secure-store or react-native-keychain.
 */

import type { ISecureEnclaveStorage, EnclaveStorageOptions } from './types';

export class MemorySecureEnclaveAdapter implements ISecureEnclaveStorage {
  private store = new Map<string, { value: string; options?: EnclaveStorageOptions }>();

  async setItem(key: string, value: string, options?: EnclaveStorageOptions): Promise<void> {
    if (!key || typeof key !== 'string') {
      throw new Error('Secure enclave key must be a non-empty string');
    }
    this.store.set(key, { value, options });
  }

  async getItem(key: string): Promise<string | null> {
    const item = this.store.get(key);
    return item ? item.value : null;
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async hasItem(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async clearAllSecureCredentials(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Validates that keys stored in secure enclave follow Pravshi security naming conventions.
 */
export function assertValidSecureKey(key: string): void {
  const allowedPrefixes = [
    'auth.session',
    'auth.refresh',
    'auth.device_signing_key',
    'auth.biometric_token',
  ];
  const isValid = allowedPrefixes.some((p) => key.startsWith(p));
  if (!isValid) {
    // We log a warning if non-standard keys are stored in the secure enclave
    console.warn(
      `[SecureEnclave] Non-standard key stored: ${key}. Ensure this contains high-value secrets only.`,
    );
  }
}
