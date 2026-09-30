import { withPermission } from '@/lib/authz/http';
import { listDeals, createDeal } from '@/lib/crm/deals';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/deals — collection.
 * GET  ?search=&stage=&limit=&offset=&companyId=&contactId=  deals.view → { rows, total, limit, offset }
 *      (search matches title prefix; stage is one of NEW/QUALIFIED/PROPOSAL/NEGOTIATION/WON/LOST)
 * POST {…deal fields}                  deals.create → 201 + the created deal
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission({ permission: 'deals.view' }, async (request, authorization) => {
  try {
    const url = new URL(request.url);
    const page = await listDeals(authorization, {
      search: url.searchParams.get('search') ?? undefined,
      stage: url.searchParams.get('stage') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
      companyId: url.searchParams.get('companyId') ?? undefined,
      contactId: url.searchParams.get('contactId') ?? undefined,
    });
    return Response.json(page, { headers: noStoreHeaders });
  } catch (error) {
    const invalid = invalidRequestResponse(error);
    if (invalid) return invalid;
    throw error;
  }
});

export const POST = withPermission(
  { permission: 'deals.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const deal = await createDeal(authorization, body);
      return Response.json(deal, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
