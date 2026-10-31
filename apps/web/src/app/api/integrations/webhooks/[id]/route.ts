import { withPermission } from '@/lib/authz/http';
import {
  integrationsFailureResponse,
  noStoreHeaders,
  parseIntegrationId,
} from '@/lib/integrations/http';
import { deleteSubscription, updateSubscription } from '@/lib/integrations/subscriptions';

/**
 * /api/integrations/webhooks/[id] (Phase 10, Wave G; contract §4.4).
 *   PATCH   integrations.manage → url / events / active edits
 *                                 (active=false is the per-subscription
 *                                 kill switch, §4.7 — recoverable)
 *   DELETE  integrations.manage → hard delete (the row's stored signing
 *                                 envelope goes with it)
 *
 * Cross-tenant and missing ids answer NOT_FOUND via the service (§4.7).
 */

export const dynamic = 'force-dynamic';

export const PATCH = withPermission(
  { permission: 'integrations.manage' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const subscription = await updateSubscription(
        authorization,
        parseIntegrationId(params.id as string),
        body,
      );
      return Response.json(subscription, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);

export const DELETE = withPermission(
  { permission: 'integrations.manage' },
  async (_request, authorization, params) => {
    try {
      await deleteSubscription(authorization, parseIntegrationId(params.id as string));
      return Response.json({ deleted: true }, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
