import { withPermission } from '@/lib/authz/http';
import {
  integrationsFailureResponse,
  noStoreHeaders,
  parseIntegrationId,
} from '@/lib/integrations/http';
import { rotateSubscriptionSecret } from '@/lib/integrations/subscriptions';

/**
 * POST /api/integrations/webhooks/[id]/rotate-secret (Phase 10, Wave G;
 * contract §4.4). Permission: integrations.manage.
 *
 * The service generates a NEW signing secret, replaces the stored vault
 * envelope in the same update (the old secret stops verifying
 * immediately — receivers must be given the new one first), and returns
 * the plaintext in this response EXACTLY ONCE:
 * { subscription, signingSecret }. The body takes no input.
 */

export const dynamic = 'force-dynamic';

export const POST = withPermission(
  { permission: 'integrations.manage' },
  async (_request, authorization, params) => {
    try {
      const rotated = await rotateSubscriptionSecret(
        authorization,
        parseIntegrationId(params.id as string),
      );
      return Response.json(rotated, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
