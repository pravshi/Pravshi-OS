/**
 * Pravshi OS  Mobile Platform Storage Abstraction Contracts.
 *
 * Enforces strict boundary between:
 * 1. Hardware Secure Enclave (Keychain / Keystore) for credentials & signing keys.
 * 2. Tenant-Isolated Cached Metadata Storage for read-only offline caches and mutation queues.
 */

export interface EnclaveStorageOptions {
  requireBiometrics?: boolean;
  accessible?: 'after_first_unlock' | 'when_unlocked' | 'device_only';
}

/**
 * Interface for OS Secure Enclave / Hardware-backed security module.
 * MUST be backed by Keychain on iOS and Keystore on Android.
 * NEVER use standard AsyncStorage or SQLite for items stored here.
 */
export interface ISecureEnclaveStorage {
  setItem(key: string, value: string, options?: EnclaveStorageOptions): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  hasItem(key: string): Promise<boolean>;
  clearAllSecureCredentials(): Promise<void>;
}

/**
 * Interface for cached read-only metadata and offline mutation queues.
 * Must enforce tenant partitioning so that data for Tenant A is strictly separated
 * from Tenant B and can be cleanly purged.
 */
export interface ITenantIsolatedCache {
  get<T>(tenantId: string, key: string): Promise<T | null>;
  set<T>(tenantId: string, key: string, value: T, ttlSeconds?: number): Promise<void>;
  remove(tenantId: string, key: string): Promise<void>;
  clearTenant(tenantId: string): Promise<void>;
  clearAllTenants(): Promise<void>;
  listKeys(tenantId: string): Promise<string[]>;
}

export interface CachedMetadataItem<T> {
  value: T;
  storedAt: number;
  expiresAt: number | null;
  tenantId: string;
}
