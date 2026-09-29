import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getContact, updateContact, deleteContact } from '@/lib/crm/contacts';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/contacts/[id] — single contact.
 * GET    contacts.view → the contact, or 404 when invisible/deleted
 * PATCH  contacts.edit → 200 + the updated contact
 * DELETE contacts.edit → 200 { ok: true } (soft delete: deleted_at = now())
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'contacts.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const contact = await getContact(authorization, id);
      return Response.json(contact, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'contacts.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const contact = await updateContact(authorization, id, body);
      return Response.json(contact, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'contacts.edit' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteContact(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
