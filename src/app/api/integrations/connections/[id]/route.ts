import { withPermission } from '@/lib/authz/http';
import {
  disconnectConnection,
  getConnection,
  updateConnection,
} from '@/lib/integrations/connections';
import {
  integrationsFailureResponse,
  noStoreHeaders,
  parseIntegrationId,
} from '@/lib/integrations/http';

/**
 * /api/integrations/connections/[id] (Phase 10, Wave G; contract §4.4).
 *   GET     integrations.view    → the safe connection summary
 *   PATCH   integrations.manage  → config / display-name / status edits
 *   DELETE  integrations.manage  → disconnect: the service destroys the
 *                                  credential before deleting the row (§4.3)
 *
 * Cross-tenant and missing ids are indistinguishable: the service throws
 * via assertTargetAffected and the caller sees the §24 NOT_FOUND
 * envelope — never a hint that the row exists elsewhere (§4.7).
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'integrations.view' },
  async (_request, authorization, params) => {
    try {
      const connection = await getConnection(
        authorization,
        parseIntegrationId(params.id as string),
      );
      return Response.json(connection, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);

export const PATCH = withPermission(
  { permission: 'integrations.manage' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const connection = await updateConnection(
        authorization,
        parseIntegrationId(params.id as string),
        body,
      );
      return Response.json(connection, { headers: noStoreHeaders });
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
      await disconnectConnection(authorization, parseIntegrationId(params.id as string));
      return Response.json({ disconnected: true }, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
