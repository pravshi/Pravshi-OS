import { requirePagePermission } from '@/lib/authz/page';
import { resolveIntegrationsConfig } from '@/lib/integrations/config';
import { listConnections } from '@/lib/integrations/connections';
import { listExecutions } from '@/lib/integrations/executions';
import { INTEGRATION_EVENT_KEYS } from '@/lib/integrations/fanout';
import { listProviderDefinitions } from '@/lib/integrations/providers';
import { listSubscriptions } from '@/lib/integrations/subscriptions';
import { getIntegrationsAccess } from '@/components/integrations/can-use-integrations';
import { IntegrationsManager } from '@/components/integrations/IntegrationsManager';
import {
  toConnectionWire,
  toExecutionWire,
  toSubscriptionWire,
  type IntegrationConnectionWire,
  type IntegrationProviderWire,
} from '@/components/integrations/integrations-client';

/**
 * /settings/integrations — the Integrations Platform surface (Phase 10,
 * Wave G; contract §4.8). integrations.view gates the page
 * (requirePagePermission); integrations.manage is computed as a display
 * flag for the manager's controls — every mutation is enforced again
 * by its API route.
 *
 * Async Server Component: the first page of each collection is loaded
 * here through the services under the page's own authorization and
 * handed to the client manager as wire shapes; the manager refreshes
 * through the API after mutations. The provider catalogue is projected
 * field-by-field (the registry's zod schemas are behaviour, not data —
 * the same projection the GET /api/integrations route answers with).
 */
export default async function IntegrationsSettingsPage() {
  const auth = await requirePagePermission('integrations.view');
  const [access, connectionsPage, subscriptionsPage, executionsPage] = await Promise.all([
    getIntegrationsAccess(),
    listConnections(auth, { limit: 200 }),
    listSubscriptions(auth, {}),
    listExecutions(auth, {}),
  ]);

  const byProvider = new Map<string, IntegrationConnectionWire[]>();
  for (const connection of connectionsPage.rows) {
    const wire = toConnectionWire(connection);
    const bucket = byProvider.get(connection.providerKey) ?? [];
    bucket.push(wire);
    byProvider.set(connection.providerKey, bucket);
  }

  const providers: IntegrationProviderWire[] = listProviderDefinitions().map((definition) => ({
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
    connections: byProvider.get(definition.key) ?? [],
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Connect Pravshi OS to the services your workspace already uses, send events out as signed
          webhooks, and receive events from external senders.
        </p>
      </div>
      <IntegrationsManager
        initialOverview={{
          vaultConfigured: resolveIntegrationsConfig().vaultConfigured,
          providers,
        }}
        initialSubscriptions={{
          ...subscriptionsPage,
          rows: subscriptionsPage.rows.map(toSubscriptionWire),
        }}
        initialExecutions={{ ...executionsPage, rows: executionsPage.rows.map(toExecutionWire) }}
        eventKeys={INTEGRATION_EVENT_KEYS}
        canManage={access.canManage}
      />
    </div>
  );
}
