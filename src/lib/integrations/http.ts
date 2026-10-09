import { ZodError } from 'zod';
import { IntegrationUuidSchema, isIntegrationsError, type IntegrationsError } from './errors';

/**
 * REST plumbing for the integrations routes (Wave G) — the module pattern
 * of src/lib/crm/http.ts and src/lib/work/http.ts, with the §24 envelope
 * shape the Phase 9 AI routes answer with ({ error: { code, message, … } }).
 *
 * Mapping owned here, so Wave G routes stay thin:
 *   IntegrationsError   → its status + code (errors.ts is the taxonomy)
 *   ZodError            → 400 INVALID_REQUEST, first issue identified by
 *                         field path via the shared invalidRequestResponse
 *                         helper (which appends the zod issue message)
 *   anything else       → null: the route rethrows, and withPermission /
 *                         the framework renders the opaque internal envelope.
 *                         AuthorizationError in particular must propagate —
 *                         it is the authz layer's to render (§24).
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const noStoreHeaders = NO_STORE;

export interface IntegrationsErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
  };
}

export function integrationsErrorEnvelope(
  code: string,
  message: string,
  requestId?: string,
): IntegrationsErrorEnvelope {
  return { error: { code, message, ...(requestId ? { requestId } : {}) } };
}

/** The response for one taxonomy error — status and message come from errors.ts only. */
export function integrationsErrorResponse(error: IntegrationsError, requestId?: string): Response {
  return Response.json(integrationsErrorEnvelope(error.code, error.message, requestId), {
    status: error.status,
    headers: NO_STORE,
  });
}

function invalidRequestResponse(error: ZodError, requestId?: string): Response {
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return Response.json(
    integrationsErrorEnvelope(
      'INVALID_REQUEST',
      `${where}${first?.message ?? 'invalid input'}`,
      requestId,
    ),
    { status: 400, headers: NO_STORE },
  );
}

/**
 * The one catch-block helper Wave G routes use:
 *
 *   try { … } catch (error) {
 *     const response = integrationsFailureResponse(error, authorization.requestId);
 *     if (response) return response;
 *     throw error;
 *   }
 *
 * Vault errors never reach this point — the service maps them into the
 * taxonomy via errors.ts `fromVaultError` before they can escape.
 */
export function integrationsFailureResponse(error: unknown, requestId?: string): Response | null {
  if (isIntegrationsError(error)) return integrationsErrorResponse(error, requestId);
  if (error instanceof ZodError) return invalidRequestResponse(error, requestId);
  return null;
}

/**
 * The [id] route guard (Wave J Finding 1; the CRM companies/[id]
 * precedent). Route params reach the services, whose SQL casts
 * `${id}::uuid` — a malformed id makes Postgres raise 22P02, which is
 * neither an IntegrationsError nor a ZodError, so the route would
 * rethrow and the caller would get an opaque 500. Parsing the param
 * here turns the malformed case into a ZodError, which
 * integrationsFailureResponse already maps to 400 INVALID_REQUEST.
 * Well-formed ids pass through unchanged. Routes call it inside their
 * try block, one line per handler:
 *
 *   const id = parseIntegrationId(params.id as string);
 *
 * The schema is the module-shared IntegrationUuidSchema (errors.ts);
 * the services assert the same shape through assertIntegrationUuid and
 * throw the typed VALIDATION instead (the service-layer half of
 * Finding 1) — two throw shapes, one schema.
 */
export function parseIntegrationId(raw: string): string {
  return IntegrationUuidSchema.parse(raw);
}
