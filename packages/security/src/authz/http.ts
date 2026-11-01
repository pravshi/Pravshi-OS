import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';
import {
  AuthorizationError,
  internalErrorEnvelope,
  isAuthorizationError,
  toErrorEnvelope,
  type ErrorEnvelope,
} from './errors';
import {
  requirePermission,
  type AccessScope,
  type Authorization,
  type AuthorizationTarget,
} from './require-permission';

/**
 * HTTP and Server Action plumbing for requirePermission(). Nothing here decides anything.
 *
 * withPermission() is the only shape a protected Route Handler takes:
 *
 *   export const GET = withPermission(
 *     { permission: 'people.view', target: (params) => ({ entity: 'person', id: params.id }) },
 *     async (request, authorization, params) => ...,
 *   );
 *
 * The handler cannot run without an Authorization, and every failure — an authorization
 * decision or anything the handler throws — leaves as the section 24 envelope. A refusal can
 * never turn into a success, and an unexpected error never carries its own message out.
 * tests/guards/require-permission-first.test.ts fails the build for a Route Handler or Server
 * Action that is not built this way, outside an explicit list of four pre-authentication routes.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function errorResponse(error: AuthorizationError): Response {
  return Response.json(toErrorEnvelope(error), { status: error.status, headers: NO_STORE });
}

export function internalErrorResponse(requestId: string): Response {
  return Response.json(internalErrorEnvelope(requestId), { status: 500, headers: NO_STORE });
}

/**
 * Request timing visibility (Phase 12, F-12-12; audit section 4.5). One structured line per
 * wrapped request — route, status, durationMs, requestId — console-transported like the [jobs]
 * lines, so platform logs can answer latency questions (the p95 of a route) without a metrics
 * stack. This is the single emission point: every module http helper's response is built inside
 * a handler and returns through withPermission(), so refusals, handler responses and error
 * envelopes are all timed here and nowhere else.
 *
 * The line carries no tenant data beyond the request id: the route is the request path (never
 * the query string, which can hold search terms), and no person, organization, header or body
 * is read. Emission is observability only — it sits in a finally, adds no awaits, and cannot
 * throw, so it never changes a response, an error, or a status.
 */
function emitRequestTiming(
  request: Request,
  status: number,
  startedAt: number,
  requestId: string,
): void {
  try {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = '(unparseable url)';
    }
    console.log('[authz] request', {
      route: `${request.method.toUpperCase()} ${path}`,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      requestId,
    });
  } catch {
    // A logging failure must never reach the request path.
  }
}

/**
 * Threat T-17. A browser always sends Origin on a cross-site state-changing request, so a mismatch
 * is refused before anything else happens. A request with no Origin is not a browser acting on
 * somebody's behalf, and still has to authenticate.
 */
function originMatches(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

export interface PermissionSpec<P> {
  readonly permission: string;
  readonly minScope?: AccessScope;
  /** Maps route params to the record this request is about. Params are untrusted. */
  readonly target?: (params: P) => AuthorizationTarget;
}

type SegmentParams = Record<string, string | string[] | undefined>;

export function withPermission<P extends SegmentParams = SegmentParams>(
  spec: PermissionSpec<P>,
  handler: (request: Request, authorization: Authorization, params: P) => Promise<Response>,
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  return async (request, context) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let status = 500;
    try {
      if (STATE_CHANGING.has(request.method.toUpperCase()) && !originMatches(request)) {
        console.warn('[authz] cross-origin request refused', { requestId });
        const refusal = new AuthorizationError('FORBIDDEN', {
          requestId,
          reason: 'ORIGIN_MISMATCH',
        });
        status = refusal.status;
        return errorResponse(refusal);
      }
      const params = ((await context?.params) ?? {}) as P;
      const authorization = await requirePermission(request.headers, {
        permission: spec.permission,
        minScope: spec.minScope,
        target: spec.target?.(params),
        requestId,
      });
      const response = await handler(request, authorization, params);
      status = response.status;
      return response;
    } catch (error) {
      if (isAuthorizationError(error)) {
        status = error.status;
        return errorResponse(error);
      }
      console.error('[authz] protected route failed', {
        requestId,
        name: error instanceof Error ? error.name : typeof error,
      });
      Sentry.captureMessage('protected route failed', { level: 'error', tags: { requestId } });
      return internalErrorResponse(requestId);
    } finally {
      emitRequestTiming(request, status, startedAt, requestId);
    }
  };
}

/**
 * Server Actions return failures as data: a thrown action error reaches the client as an opaque
 * failure in production, which would hide STEP_UP_REQUIRED from the interface that has to act on
 * it. The pattern is:
 *
 *   'use server';
 *   export async function doThing(input: unknown) {
 *     try {
 *       const authorization = await requirePermission(new Headers(await headers()), { ... });
 *       ...
 *     } catch (error) {
 *       return actionError(error);
 *     }
 *   }
 */
export function actionError(error: unknown): ErrorEnvelope {
  if (isAuthorizationError(error)) return toErrorEnvelope(error);
  const requestId = randomUUID();
  console.error('[authz] protected action failed', {
    requestId,
    name: error instanceof Error ? error.name : typeof error,
  });
  Sentry.captureMessage('protected action failed', { level: 'error', tags: { requestId } });
  return internalErrorEnvelope(requestId);
}
