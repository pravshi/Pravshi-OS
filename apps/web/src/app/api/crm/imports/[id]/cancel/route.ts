import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/crm/http';
import { importErrorResponse } from '@/lib/import/sales-sheet/http';
import { cancelImport } from '@/lib/import/sales-sheet/service';

/**
 * /api/crm/imports/:id/cancel — cancel a previewed or queued import (BP-06).
 * POST  crm.import (the importer only — enforced by the database) → the import, CANCELLED.
 *       409 once the commit has started.
 */

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const POST = withPermission<Params>(
  { permission: 'crm.import' },
  async (_request, authorization, params) => {
    try {
      return Response.json(await cancelImport(authorization, params.id), {
        headers: noStoreHeaders,
      });
    } catch (error) {
      const handled = importErrorResponse(error);
      if (handled) return handled;
      throw error;
    }
  },
);
