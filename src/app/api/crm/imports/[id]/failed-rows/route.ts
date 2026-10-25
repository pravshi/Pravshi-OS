import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/crm/http';
import { importErrorResponse } from '@/lib/import/sales-sheet/http';
import { failedRowsFor } from '@/lib/import/sales-sheet/service';

/**
 * /api/crm/imports/:id/failed-rows — the failed rows as CSV (BP-06, AC-C4).
 * GET  crm.import → text/csv: source row number, the original values, the reasons. Values a
 *      spreadsheet could execute are escaped.
 */

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = withPermission<Params>(
  { permission: 'crm.import' },
  async (_request, authorization, params) => {
    try {
      const csv = await failedRowsFor(authorization, params.id);
      return new Response(csv, {
        headers: {
          ...noStoreHeaders,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="import-${params.id}-failed-rows.csv"`,
        },
      });
    } catch (error) {
      const handled = importErrorResponse(error);
      if (handled) return handled;
      throw error;
    }
  },
);
