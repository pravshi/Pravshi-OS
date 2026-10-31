'use client';

import { useCallback, useState } from 'react';
import { ConnectionsSection } from './ConnectionsSection';
import { ExecutionsSection } from './ExecutionsSection';
import { OneTimeSecret } from './OneTimeSecret';
import { SubscriptionsSection } from './SubscriptionsSection';
import {
  dismissSecret,
  fetchExecutions,
  fetchIntegrationsOverview,
  fetchSubscriptions,
  type IntegrationExecutionPageWire,
  type IntegrationExecutionWire,
  type IntegrationsOverviewWire,
  type RevealedSecret,
  type WebhookSubscriptionPageWire,
} from './integrations-client';

/**
 * IntegrationsManager — the client composition for
 * /settings/integrations (Phase 10, Wave G; contract §4.8).
 *
 * Initial data arrives server-rendered from the page (which loaded it
 * through the services under the page's own authorization); every
 * mutation then round-trips the /api/integrations routes through
 * integrations-client and refreshes the affected collection from the
 * response of a fresh read. The one-time reveal lives here so a
 * subscription secret and an inbound URL never compete for the slot:
 * revealing one replaces the other, and dismissing drops the plaintext
 * from the browser entirely (dismissSecret).
 */
export interface IntegrationsManagerProps {
  readonly initialOverview: IntegrationsOverviewWire;
  readonly initialSubscriptions: WebhookSubscriptionPageWire;
  readonly initialExecutions: IntegrationExecutionPageWire;
  /** The fan-out event catalogue (INTEGRATION_EVENT_KEYS), passed from the server. */
  readonly eventKeys: readonly string[];
  /** Display flag from can-use-integrations.ts — never authorization. */
  readonly canManage: boolean;
}

export function IntegrationsManager({
  initialOverview,
  initialSubscriptions,
  initialExecutions,
  eventKeys,
  canManage,
}: IntegrationsManagerProps) {
  const [overview, setOverview] = useState(initialOverview);
  const [subscriptions, setSubscriptions] = useState(initialSubscriptions);
  const [executions, setExecutions] = useState(initialExecutions);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  const refreshOverview = useCallback(async () => {
    setOverview(await fetchIntegrationsOverview());
  }, []);

  const refreshSubscriptions = useCallback(async () => {
    setSubscriptions(await fetchSubscriptions());
  }, []);

  const refreshExecutions = useCallback(async (kind?: IntegrationExecutionWire['kind']) => {
    setExecutions(await fetchExecutions(kind));
  }, []);

  return (
    <div className="space-y-8">
      {revealed && (
        <OneTimeSecret revealed={revealed} onDismiss={() => setRevealed(dismissSecret())} />
      )}
      <ConnectionsSection
        providers={overview.providers}
        vaultConfigured={overview.vaultConfigured}
        canManage={canManage}
        onChanged={refreshOverview}
        onReveal={setRevealed}
      />
      <SubscriptionsSection
        subscriptions={subscriptions}
        eventKeys={eventKeys}
        vaultConfigured={overview.vaultConfigured}
        canManage={canManage}
        onChanged={refreshSubscriptions}
        onReveal={setRevealed}
      />
      <ExecutionsSection executions={executions} onRefresh={refreshExecutions} />
    </div>
  );
}
