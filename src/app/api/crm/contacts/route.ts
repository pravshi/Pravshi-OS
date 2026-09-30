import { withPermission } from '@/lib/authz/http';
import { listContacts, createContact } from '@/lib/crm/contacts';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/contacts — collection.
 * GET  ?search=&limit=&offset=&companyId=   contacts.view   → { rows, total, limit, offset }
 *      (search matches name prefix or email prefix)
 * POST {…contact fields}          contacts.create → 201 + the created contact
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'contacts.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const page = await listContacts(authorization, {
        search: url.searchParams.get('search') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
        companyId: url.searchParams.get('companyId') ?? undefined,
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
  { permission: 'contacts.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const contact = await createContact(authorization, body);
      return Response.json(contact, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
