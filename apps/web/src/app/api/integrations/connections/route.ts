import { withPermission } from '@/lib/authz/http';
import { createConnection } from '@/lib/integrations/connections';
import { integrationsFailureResponse, noStoreHeaders } from '@/lib/integrations/http';

/**
 * POST /api/integrations/connections — create/configure a connection
 * (Phase 10, Wave G; contract §4.4). Permission: integrations.manage.
 *
 * Thin over the connections service: the body is parsed there against
 * CreateConnectionInputSchema, the provider's config schema, and the
 * credential-tier rules (§4.3). A Tier V body carries the secret exactly
 * once; the 201 response is the service's safe summary, which has no
 * credential field at all — the secret is never echoed.
 */

export const dynamic = 'force-dynamic';

export const POST = withPermission(
  { permission: 'integrations.manage' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const connection = await createConnection(authorization, body);
      return Response.json(connection, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
