import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/crm/http';
import {
  bodyTooLargeResponse,
  importErrorResponse,
  readCappedBody,
  requireImportWritePermissions,
} from '@/lib/import/sales-sheet/http';
import { DecisionInput, getDecisionPreview, setDecision } from '@/lib/import/sales-sheet/service';

/**
 * /api/crm/imports/:id/decisions — duplicate decisions (0088).
 * GET  crm.import → the preview recomputed from the recorded rows and the decisions: counts
 *      (what confirm compares once the import has a decision; an undecided import is confirmed
 *      against its upload preview), undecided possible duplicates by entity key, rows the
 *      decisions skip or make invalid, and the decisions. Row values are never returned; an
 *      entity key does carry a normalised company / contact name or email from the file, and is
 *      seen only by the importer or a GLOBAL holder of crm.import (the 0088 policies).
 * PUT  crm.import + companies.create + contacts.create + deals.create
 *      { kind: COMPANY|CONTACT|DEAL, key, decision: LINK_EXISTING|CREATE_NEW|SKIP|null }
 *      → the recomputed preview. Only the importer, only while PREVIEWED (409 otherwise); the
 *      key must be a possible duplicate of this import (422 otherwise). null clears a decision.
 */

export const dynamic = 'force-dynamic';

type Params = { id: string };

const DECISION_BODY_MAX_BYTES = 4 * 1024;

export const GET = withPermission<Params>(
  { permission: 'crm.import' },
  async (_request, authorization, params) => {
    try {
      return Response.json(await getDecisionPreview(authorization, params.id), {
        headers: noStoreHeaders,
      });
    } catch (error) {
      const handled = importErrorResponse(error);
      if (handled) return handled;
      throw error;
    }
  },
);

export const PUT = withPermission<Params>(
  { permission: 'crm.import' },
  async (request, authorization, params) => {
    await requireImportWritePermissions(request, authorization);
    const raw = await readCappedBody(request, DECISION_BODY_MAX_BYTES);
    if (raw === null) return bodyTooLargeResponse(DECISION_BODY_MAX_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      body = undefined;
    }
    try {
      const input = DecisionInput.parse(body);
      return Response.json(await setDecision(authorization, params.id, input), {
        headers: noStoreHeaders,
      });
    } catch (error) {
      const handled = importErrorResponse(error);
      if (handled) return handled;
      throw error;
    }
  },
);
