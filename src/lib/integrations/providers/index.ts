import { emailProvider } from './email';
import { webhooksProvider } from './webhooks';
import type { IntegrationProviderDefinition } from './types';

/**
 * The provider registry — Phase 10 contract §4.1 [DECISION]: definitions
 * are code, this record is the whole registry. V1 ships exactly the two
 * providers §4.6 justifies from existing machinery (email, generic
 * webhooks); OAuth and business-data sync providers are deferred (§4.6
 * item 3) and join by adding an entry here — no migration, no table.
 *
 * Every key of this record MUST equal its definition's `key` (the DB
 * stores the key string; a drift between the two would orphan rows). The
 * unit suite (tests/integrations/connections-unit.test.ts) pins that, the
 * tier vocabulary, and that each defaultConfig parses under its schema.
 */
export const INTEGRATION_PROVIDERS: Readonly<Record<string, IntegrationProviderDefinition>> = {
  [emailProvider.key]: emailProvider,
  [webhooksProvider.key]: webhooksProvider,
};

export const PROVIDER_KEYS: readonly string[] = Object.keys(INTEGRATION_PROVIDERS);

export function isProviderKey(key: string): boolean {
  return Object.hasOwn(INTEGRATION_PROVIDERS, key);
}

/** The definition for a key, or null when the key is not a registered provider. */
export function getProviderDefinition(key: string): IntegrationProviderDefinition | null {
  return INTEGRATION_PROVIDERS[key] ?? null;
}

/** All definitions, in registry order — the GET /api/integrations catalogue (Wave G). */
export function listProviderDefinitions(): IntegrationProviderDefinition[] {
  return Object.values(INTEGRATION_PROVIDERS);
}

export type {
  IntegrationProviderDefinition,
  ProviderCapability,
  ProviderHealthCheckDescriptor,
  ProviderInboundDescriptor,
} from './types';
