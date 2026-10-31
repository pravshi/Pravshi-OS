import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { integrationsFailureResponse, noStoreHeaders } from '@/lib/integrations/http';
import { createSubscription, listSubscriptions } from '@/lib/integrations/subscriptions';

/**
 * /api/integrations/webhooks — outbound webhook subscriptions
 * (Phase 10, Wave G; contract §4.4/§4.5).
 *   GET   ?active=&limit=&offset=   integrations.view   → subscription page
 *   POST  { url, events }           integrations.manage → 201 +
 *         { subscription, signingSecret } — the signing secret is
 *         generated server-side, stored only as a vault envelope, and
 *         returned in this response EXACTLY ONCE (§4.3); the list/get
 *         shapes never carry it.
 *
 * URL validation happens in the service: the static SSRF check as a
 * create-time fail-fast (delivery re-validates in full, §4.7). Vault
 * not configured → the service's typed NOT_CONFIGURED (503).
 */

export const dynamic = 'force-dynamic';

const ListRouteQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withPermission(
  { permission: 'integrations.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const query = ListRouteQuery.parse({
        active: url.searchParams.get('active') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      const page = await listSubscriptions(authorization, {
        active: query.active === undefined ? undefined : query.active === 'true',
        limit: query.limit,
        offset: query.offset,
      });
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);

export const POST = withPermission(
  { permission: 'integrations.manage' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const created = await createSubscription(authorization, body);
      return Response.json(created, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
