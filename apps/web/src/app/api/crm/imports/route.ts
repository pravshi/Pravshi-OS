import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/crm/http';
import {
  fileTooLargeResponse,
  importErrorResponse,
  readCappedBody,
  requireImportWritePermissions,
} from '@/lib/import/sales-sheet/http';
import { createImportPreview } from '@/lib/import/sales-sheet/service';

/**
 * /api/crm/imports — upload a Sales Sheet CSV for preview (BP-06, AC-P1).
 * POST ?fileName=<name>   body: the CSV bytes (text/csv)
 *      crm.import + companies.create + contacts.create + deals.create
 *      → 201 + the recorded import with its preview; nothing is written to the CRM yet.
 *      413 over the file limit; 422 when the whole file is refused (encoding, columns, rows).
 */

export const dynamic = 'force-dynamic';

export const POST = withPermission({ permission: 'crm.import' }, async (request, authorization) => {
  await requireImportWritePermissions(request, authorization);
  const bytes = await readCappedBody(request);
  if (bytes === null) return fileTooLargeResponse();
  try {
    const view = await createImportPreview(authorization, {
      fileName: new URL(request.url).searchParams.get('fileName') ?? undefined,
      bytes,
    });
    return Response.json(view, { status: 201, headers: noStoreHeaders });
  } catch (error) {
    const handled = importErrorResponse(error);
    if (handled) return handled;
    throw error;
  }
});
