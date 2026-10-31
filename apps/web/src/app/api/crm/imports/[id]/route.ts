import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/crm/http';
import { importErrorResponse } from '@/lib/import/sales-sheet/http';
import { getImport } from '@/lib/import/sales-sheet/service';

/**
 * /api/crm/imports/:id — one import (BP-06).
 * GET   crm.import → the import: status, preview counts, invalid rows (number, column, reason),
 *       possible duplicates, final counts. Never row values.
 */

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = withPermission<Params>(
  { permission: 'crm.import' },
  async (_request, authorization, params) => {
    try {
      return Response.json(await getImport(authorization, params.id), {
        headers: noStoreHeaders,
      });
    } catch (error) {
      const handled = importErrorResponse(error);
      if (handled) return handled;
      throw error;
    }
  },
);
