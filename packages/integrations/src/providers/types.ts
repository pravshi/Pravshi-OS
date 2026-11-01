import type { z } from 'zod';
import type { CredentialTier } from '../config';

/**
 * Provider registry types — Phase 10 contract §4.1 [DECISION] and §4.6.
 *
 * Provider definitions are CODE, never database rows: the registry in this
 * directory is the single source of truth for which providers exist, how
 * their credentials are held (§4.3 tiers), what non-secret configuration
 * they accept, and whether they can receive inbound webhooks. The database
 * (integration_connections) holds only an org's state against a `key` from
 * this registry; the service enforces that the key exists here.
 *
 * A definition carries NO behaviour: no adapter, no fetch, no provider call.
 * Adapters land in Waves P (email) and W (webhooks) and consume these
 * definitions; keeping behaviour out of the registry is what lets the
 * connections service, the API and the UI all read the same metadata
 * without importing a transmission path.
 */

/** What a provider can do in V1. Extensible; not every provider has all. */
export type ProviderCapability = 'email' | 'webhooks_outbound' | 'webhooks_inbound';

/**
 * How a connection's health is established (Wave G's health surface reads
 * this; Wave C's recordConnectionHealth stores the outcomes).
 *   'none'   — no health signal exists for this provider in V1.
 *   'config' — health = the required configuration/credential is present.
 *   'live'   — an adapter performs a real provider round-trip (Wave P/W).
 */
export interface ProviderHealthCheckDescriptor {
  readonly kind: 'none' | 'config' | 'live';
  readonly description: string;
}

/** Inbound webhook support (§4.5). `null` means: no inbound for this provider in V1. */
export interface ProviderInboundDescriptor {
  /**
   * Verification mode the Wave W-in verifier must apply:
   *   'hmac-sha256'      — HMAC-SHA256 over the raw body with the connection's
   *                        vault secret, constant-time compare.
   *   'endpoint-token'   — the unguessable endpoint key alone authenticates
   *                        (the generic provider's V1 mode, §4.5).
   */
  readonly verification: 'hmac-sha256' | 'endpoint-token';
  /** Body-size cap enforced BEFORE parsing (§4.4). Contract default: 256 KB. */
  readonly maxBodyBytes: number;
}

export interface IntegrationProviderDefinition {
  /** Stable registry key; stored as integration_connections.provider_key. */
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  /**
   * True when an org may hold at most ONE connection to this provider.
   * Enforced in the service (create → CONFLICT), per §4.1 — deliberately
   * not a database unique constraint, so non-singleton providers stay free.
   */
  readonly singleton: boolean;
  /** §4.3: where this provider's credential lives. */
  readonly credentialTier: CredentialTier;
  /**
   * Tier E only: the deployment env var a connection's `credential_ref`
   * must name. Fixed per provider (not free text) so a connection can never
   * point its ref at an unrelated secret. Null for Tier V providers.
   */
  readonly credentialRefEnvVar: string | null;
  /**
   * Zod schema for the NON-SECRET `config` jsonb (§4.1). Must be a strict
   * object schema: unknown keys are rejected, and the service additionally
   * scans for credential-shaped keys before parsing (connections.ts), so a
   * secret can never be smuggled into config even under an innocent name
   * the schema would accept.
   */
  readonly configSchema: z.ZodType<Record<string, unknown>>;
  /** The config a connection starts with when the caller supplies none. */
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly ProviderCapability[];
  readonly healthCheck: ProviderHealthCheckDescriptor;
  readonly inbound: ProviderInboundDescriptor | null;
}
