import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/crm/http';
import {
  CONFIRM_BODY_MAX_BYTES,
  bodyTooLargeResponse,
  importErrorResponse,
  readCappedBody,
  requireImportWritePermissions,
} from '@/lib/import/sales-sheet/http';
import { confirmImport } from '@/lib/import/sales-sheet/service';

/**
 * /api/crm/imports/:id/confirm — commit the preview the user saw (BP-06, AC-P3, AC-I1, AC-I3).
 * POST { fileSha256, counts, includeRows?, allowReimport? }
 *      crm.import + companies.create + contacts.create + deals.create + jobs.create
 *      → 202 + the import, QUEUED for the background commit. Repeating it returns the same
 *      import and starts no second job. 409 when the file or counts differ from the preview,
 *      or the file was already imported (with earlierImportId) and allowReimport is not set.
 */

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const POST = withPermission<Params>(
  { permission: 'crm.import' },
  async (request, authorization, params) => {
    await requireImportWritePermissions(request, authorization, ['jobs.create']);
    // includeRows holds at most 10,000 row numbers: 256 KiB is ample, and nothing larger is read.
    const raw = await readCappedBody(request, CONFIRM_BODY_MAX_BYTES);
    if (raw === null) return bodyTooLargeResponse(CONFIRM_BODY_MAX_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      body = undefined;
    }
    try {
      const view = await confirmImport(authorization, params.id, body);
      return Response.json(view, { status: 202, headers: noStoreHeaders });
    } catch (error) {
      const handled = importErrorResponse(error);
      if (handled) return handled;
      throw error;
    }
  },
);
