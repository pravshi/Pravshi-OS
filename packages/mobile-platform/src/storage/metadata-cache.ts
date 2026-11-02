/**
 * Pravshi OS  Mobile Platform Tenant-Isolated Metadata Cache.
 *
 * Implements strict tenant partitioning for offline cached metadata,
 * preventing cross-tenant leakage on shared devices or multi-tenant switches.
 */

import type { ITenantIsolatedCache, CachedMetadataItem } from './types';

export class TenantIsolatedMemoryCache implements ITenantIsolatedCache {
  // Store items keyed by `${tenantId}:${key}`
  private cache = new Map<string, CachedMetadataItem<unknown>>();

  private buildKey(tenantId: string, key: string): string {
    if (!tenantId || !key) {
      throw new Error(
        `Both tenantId and key are required. Got tenantId: "${tenantId}", key: "${key}"`,
      );
    }
    return `${tenantId.toLowerCase()}::${key}`;
  }

  async get<T>(tenantId: string, key: string): Promise<T | null> {
    const compositeKey = this.buildKey(tenantId, key);
    const item = this.cache.get(compositeKey);

    if (!item) return null;

    if (item.expiresAt !== null && Date.now() > item.expiresAt) {
      this.cache.delete(compositeKey);
      return null;
    }

    return item.value as T;
  }

  async set<T>(tenantId: string, key: string, value: T, ttlSeconds?: number): Promise<void> {
    const compositeKey = this.buildKey(tenantId, key);
    const now = Date.now();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;

    this.cache.set(compositeKey, {
      value,
      storedAt: now,
      expiresAt,
      tenantId: tenantId.toLowerCase(),
    });
  }

  async remove(tenantId: string, key: string): Promise<void> {
    const compositeKey = this.buildKey(tenantId, key);
    this.cache.delete(compositeKey);
  }

  async clearTenant(tenantId: string): Promise<void> {
    const prefix = `${tenantId.toLowerCase()}::`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) {
        this.cache.delete(k);
      }
    }
  }

  async clearAllTenants(): Promise<void> {
    this.cache.clear();
  }

  async listKeys(tenantId: string): Promise<string[]> {
    const prefix = `${tenantId.toLowerCase()}::`;
    const keys: string[] = [];

    for (const [compositeKey, item] of this.cache.entries()) {
      if (compositeKey.startsWith(prefix)) {
        if (item.expiresAt === null || Date.now() <= item.expiresAt) {
          keys.push(compositeKey.substring(prefix.length));
        }
      }
    }

    return keys;
  }
}
