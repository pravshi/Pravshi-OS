import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getCompany, updateCompany, deleteCompany } from '@/lib/crm/companies';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/companies/[id] — single company.
 * GET    companies.view → the company, or 404 when invisible/deleted
 * PATCH  companies.edit → 200 + the updated company
 * DELETE companies.delete → 200 { ok: true } (soft delete: deleted_at = now())
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'companies.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const company = await getCompany(authorization, id);
      return Response.json(company, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'companies.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const company = await updateCompany(authorization, id, body);
      return Response.json(company, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'companies.delete' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteCompany(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
