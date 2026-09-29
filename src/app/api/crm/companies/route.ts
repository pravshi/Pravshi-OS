import { withPermission } from '@/lib/authz/http';
import { listCompanies, createCompany } from '@/lib/crm/companies';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/companies — collection.
 * GET  ?search=&limit=&offset=   companies.view   → { rows, total, limit, offset }
 * POST {…company fields}          companies.create → 201 + the created company
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'companies.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const page = await listCompanies(authorization, {
        search: url.searchParams.get('search') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission(
  { permission: 'companies.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const company = await createCompany(authorization, body);
      return Response.json(company, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
