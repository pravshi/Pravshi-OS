/**
 * REST plumbing for /api/crm/imports (BP-06). The routes authorize crm.import through
 * withPermission(); the write routes then require, through requirePermission() and with the same
 * audit trail, the create permission of every table the file writes (AC-S1) and jobs.create for
 * the background commit. Errors carry codes and messages, never row values.
 */
import { requirePermission, type Authorization } from '@/lib/authz/require-permission';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';
import { DEFAULT_LIMITS } from './csv';
import { ImportRefusal } from './preview';
import { ImportServiceError } from './service';

/** AC-S1: every table an import writes. Activities are not imported by the current mapping. */
export const IMPORT_WRITE_PERMISSIONS = ['companies.create', 'contacts.create', 'deals.create'];

export async function requireImportWritePermissions(
  request: Request,
  authorization: Authorization,
  extra: readonly string[] = [],
): Promise<void> {
  for (const permission of [...IMPORT_WRITE_PERMISSIONS, ...extra]) {
    await requirePermission(request.headers, { permission, requestId: authorization.requestId });
  }
}

/**
 * Reads the request body, refusing it as soon as it exceeds the file limit: an oversized upload
 * is never buffered whole (AC-F2). Returns null when it is too large.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number = DEFAULT_LIMITS.maxBytes,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function fileTooLargeResponse(): Response {
  return Response.json(
    {
      error: 'FILE_TOO_LARGE',
      message: `The file is larger than ${DEFAULT_LIMITS.maxBytes} bytes.`,
    },
    { status: 413, headers: noStoreHeaders },
  );
}

/** The confirmation body limit: includeRows holds at most 10,000 row numbers. */
export const CONFIRM_BODY_MAX_BYTES = 256 * 1024;

export function bodyTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    { error: 'BODY_TOO_LARGE', message: `The request body is larger than ${maxBytes} bytes.` },
    { status: 413, headers: noStoreHeaders },
  );
}

const SERVICE_STATUS: Record<ImportServiceError['code'], number> = {
  NOT_FOUND: 404,
  NOT_IMPORTER: 403,
  PREVIEW_MISMATCH: 409,
  ALREADY_IMPORTED: 409,
  NOT_PREVIEWED: 409,
  INVALID_INCLUDE: 422,
};

/** The response for an import refusal or service error, or null for anything else. */
export function importErrorResponse(error: unknown): Response | null {
  const invalid = invalidRequestResponse(error);
  if (invalid) return invalid;
  if (error instanceof ImportRefusal) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: 422, headers: noStoreHeaders },
    );
  }
  if (error instanceof ImportServiceError) {
    return Response.json(
      { error: error.code, message: error.message, ...error.details },
      { status: SERVICE_STATUS[error.code], headers: noStoreHeaders },
    );
  }
  return null;
}
