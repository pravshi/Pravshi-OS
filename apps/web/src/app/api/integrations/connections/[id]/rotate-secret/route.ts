import { withPermission } from '@/lib/authz/http';
import { rotateConnectionSecret } from '@/lib/integrations/connections';
import {
  integrationsFailureResponse,
  noStoreHeaders,
  parseIntegrationId,
} from '@/lib/integrations/http';

/**
 * POST /api/integrations/connections/[id]/rotate-secret (Phase 10,
 * Wave G; contract §4.4). Permission: integrations.manage.
 *
 * Tier V: the body carries the replacement secret ({ secret }) and the
 * service re-encrypts it under the vault. Tier E: the body may name the
 * replacement ref ({ credentialRef }), which must equal the provider's
 * fixed env var — anything else is VALIDATION. The response is the safe
 * connection summary; neither the old nor the new secret is ever in it.
 * Audited by the service at HIGH severity.
 */

export const dynamic = 'force-dynamic';

export const POST = withPermission(
  { permission: 'integrations.manage' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const connection = await rotateConnectionSecret(
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
