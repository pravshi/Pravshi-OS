import { z } from 'zod';
import type { IntegrationProviderDefinition } from './types';

/**
 * Generic webhooks — Phase 10 contract §4.6 item 2, §4.5.
 *
 * The org-level enablement record for the generic webhook provider:
 * outbound subscriptions and inbound endpoints are their own tables
 * (integration_webhook_subscriptions, integration_inbound_events), and this
 * connection is the provider's per-org state + health surface for them.
 * Singleton: one enablement record per org is all the model needs.
 *
 * Tier V (§4.3): a connection-level secret an admin pastes here is an
 * org-entered credential (e.g. a shared inbound verification secret for a
 * sender that cannot use per-endpoint tokens), so it is vault-encrypted.
 * Per-subscription signing secrets are generated server-side and stored on
 * the subscription rows by Wave W-out — they never pass through this
 * connection. Creating this connection does not require a secret; the tier
 * governs how a supplied secret is stored, and Wave K's gate applies when
 * one is supplied (connections.ts).
 */
export const WebhooksConfigSchema = z.strictObject({
  /**
   * Whether outbound event fan-out is enabled for this org (§4.5).
   * Defaults to true at create time via defaultConfig below; an admin can
   * pause all outbound delivery without deleting subscriptions.
   */
  outboundEnabled: z.boolean().optional(),
  /** Whether the inbound receiver accepts events for this org (§4.5). */
  inboundEnabled: z.boolean().optional(),
});

export const webhooksProvider: IntegrationProviderDefinition = {
  key: 'webhooks',
  displayName: 'Webhooks',
  description:
    'Generic webhooks: outbound event subscriptions with HMAC-signed ' +
    'deliveries, and an inbound receiver for external event senders.',
  singleton: true,
  credentialTier: 'vault',
  credentialRefEnvVar: null,
  configSchema: WebhooksConfigSchema,
  defaultConfig: { outboundEnabled: true, inboundEnabled: true },
  capabilities: ['webhooks_outbound', 'webhooks_inbound'],
  healthCheck: {
    kind: 'config',
    description:
      'Healthy when the connection is enabled; delivery-level health lives ' +
      'on the subscription rows and the jobs queue.',
  },
  inbound: {
    verification: 'endpoint-token',
    maxBodyBytes: 256 * 1024,
  },
};
