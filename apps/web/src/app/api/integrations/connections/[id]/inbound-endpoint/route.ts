import { env } from '@/env';
import { withPermission } from '@/lib/authz/http';
import {
  integrationsFailureResponse,
  noStoreHeaders,
  parseIntegrationId,
} from '@/lib/integrations/http';
import { issueInboundEndpointKey } from '@/lib/integrations/inbound';

/**
 * POST /api/integrations/connections/[id]/inbound-endpoint (Phase 10,
 * Wave G; contract §4.4/§4.5). Permission: integrations.manage.
 *
 * Issues — or rotates, which is the same operation — the connection's
 * inbound endpoint key. The service stores only the key's SHA-256
 * digest; the plaintext token returns HERE, exactly once, together with
 * the full inbound URL the admin gives the external sender. Rotating
 * overwrites the digest, so the previous URL stops resolving the moment
 * this answers. The body takes no input.
 */

export const dynamic = 'force-dynamic';

export const POST = withPermission(
  { permission: 'integrations.manage' },
  async (_request, authorization, params) => {
    try {
      const issued = await issueInboundEndpointKey(
        authorization,
        parseIntegrationId(params.id as string),
      );
      const origin = new URL(env.APP_URL).origin;
      return Response.json(
        { ...issued, inboundUrl: `${origin}/api/integrations/inbound/${issued.endpointKey}` },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
