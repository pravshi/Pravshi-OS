import { withPermission } from '@/lib/authz/http';
import { resolveIntegrationsConfig } from '@/lib/integrations/config';
import { listConnections, type IntegrationConnectionSummary } from '@/lib/integrations/connections';
import { integrationsFailureResponse, noStoreHeaders } from '@/lib/integrations/http';
import {
  listProviderDefinitions,
  type IntegrationProviderDefinition,
} from '@/lib/integrations/providers';

/**
 * GET /api/integrations — the provider catalogue (code registry) merged
 * with this org's connections (Phase 10, Wave G; contract §4.4).
 * Permission: integrations.view.
 *
 * The registry definition is projected field-by-field: its zod
 * configSchema is behaviour, not data, and never serialises. Connections
 * arrive through the connections service's safe DTO — no ciphertext,
 * nonce or secret exists in this response (§4.3). `vaultConfigured`
 * rides along so the settings UI can render the Tier V not-configured
 * state without a second round-trip (§4.8).
 */

export const dynamic = 'force-dynamic';

function providerWire(
  definition: IntegrationProviderDefinition,
  connections: readonly IntegrationConnectionSummary[],
) {
  return {
    key: definition.key,
    displayName: definition.displayName,
    description: definition.description,
    singleton: definition.singleton,
    credentialTier: definition.credentialTier,
    credentialRefEnvVar: definition.credentialRefEnvVar,
    capabilities: definition.capabilities,
    healthCheck: definition.healthCheck,
    inbound: definition.inbound,
    defaultConfig: definition.defaultConfig,
    connections,
  };
}

export const GET = withPermission(
  { permission: 'integrations.view' },
  async (_request, authorization) => {
    try {
      const page = await listConnections(authorization, { limit: 200 });
      const byProvider = new Map<string, IntegrationConnectionSummary[]>();
      for (const connection of page.rows) {
        const bucket = byProvider.get(connection.providerKey) ?? [];
        bucket.push(connection);
        byProvider.set(connection.providerKey, bucket);
      }
      const providers = listProviderDefinitions().map((definition) =>
        providerWire(definition, byProvider.get(definition.key) ?? []),
      );
      return Response.json(
        { vaultConfigured: resolveIntegrationsConfig().vaultConfigured, providers },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
