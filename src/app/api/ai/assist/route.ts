import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { runAiRequest } from '@/lib/ai/orchestrator';
import { AI_CAPABILITY_IDS, AI_TARGET_ENTITY_TYPES, type AiRequestOutcome } from '@/lib/ai/types';

/**
 * POST /api/ai/assist — the one AI entry point (Phase 9, Workstream G;
 * contract §5). Permission: ai.use (a coarse gate — every record the
 * orchestrator touches is authorized again by its own entity permission +
 * RLS inside the context builder and services, §7.1).
 *
 * The route owns ONLY the HTTP mapping of contract §5.2–§5.4:
 *   body (zod strictObject, ≤ 16 KB)  → runAiRequest(auth, input, meta)
 *   outcome status 'ok'               → 200, the §5.3 AiAssistSuccess body
 *   outcome 'not_configured'          → 503 AI_NOT_CONFIGURED
 *   outcome 'limited'                 → 429 AI_LIMITED (+ retryAfterSeconds
 *                                       in the error object when supplied)
 *   outcome 'provider_failed'         → 502 AI_PROVIDER_FAILED (safe static
 *                                       message; the §3.2 taxonomy code
 *                                       lives in the usage row + logs only)
 *   Error('INVALID_REQUEST: …')       → 400 INVALID_REQUEST (unknown
 *                                       capability, capability/target
 *                                       mismatch, missing question — the
 *                                       orchestrator's thrown channel)
 *   AuthorizationError from services  → propagates: withPermission renders
 *                                       the §24 envelope (404 NOT_FOUND —
 *                                       an invisible or cross-tenant target
 *                                       never leaks its existence, §5.4)
 *
 * The orchestrator contract consumed here is Workstream C's
 * src/lib/ai/types.ts (AiRequestOutcome, reconciled at integration):
 * runAiRequest(auth, input, meta) resolves to the outcome union and throws
 * only AuthorizationError / INVALID_REQUEST-prefixed errors.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** §5.2: body ≤ 16 KB. */
const MAX_BODY_BYTES = 16 * 1024;

/** §5.2 request body — strict: unknown keys, unknown capabilities and
 * unknown entity types are all rejected as INVALID_REQUEST. */
const AssistBodySchema = z.strictObject({
  capability: z.enum(AI_CAPABILITY_IDS),
  target: z
    .strictObject({
      entityType: z.enum(AI_TARGET_ENTITY_TYPES),
      entityId: z.string().uuid(),
    })
    .optional(),
  question: z.string().max(2000).optional(),
});

/** The §24 envelope ({ error: { code, message, … } }) for §5.4 failures. */
function aiErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryAfterSeconds?: number | null,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        requestId,
        ...(retryAfterSeconds !== undefined && retryAfterSeconds !== null
          ? { retryAfterSeconds }
          : {}),
      },
    },
    { status, headers: NO_STORE },
  );
}

function invalidRequestResponse(message: string, requestId: string): Response {
  return aiErrorResponse(400, 'INVALID_REQUEST', message, requestId);
}

export const POST = withPermission({ permission: 'ai.use' }, async (request, authorization) => {
  const requestId = authorization.requestId;

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return invalidRequestResponse('Request body must be at most 16 KB.', requestId);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return invalidRequestResponse('Request body must be valid JSON.', requestId);
  }

  const parsed = AssistBodySchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return invalidRequestResponse(`${where}${first?.message ?? 'invalid input'}`, requestId);
  }

  let outcome: AiRequestOutcome;
  try {
    outcome = await runAiRequest(
      authorization,
      {
        capability: parsed.data.capability,
        target: parsed.data.target,
        question: parsed.data.question,
      },
      authorization.meta,
    );
  } catch (error) {
    if (error instanceof Error) {
      const match = /^INVALID_REQUEST:\s*(.+)$/.exec(error.message);
      if (match) return invalidRequestResponse(match[1]!, requestId);
    }
    throw error;
  }

  switch (outcome.status) {
    case 'ok':
      return Response.json(outcome, { headers: NO_STORE });
    case 'not_configured':
      return aiErrorResponse(
        503,
        'AI_NOT_CONFIGURED',
        "AI isn't configured for this workspace yet.",
        requestId,
      );
    case 'limited':
      return aiErrorResponse(
        429,
        'AI_LIMITED',
        'AI usage limit reached for this workspace. Please try again later.',
        requestId,
        outcome.retryAfterSeconds,
      );
    case 'provider_failed':
      return aiErrorResponse(
        502,
        'AI_PROVIDER_FAILED',
        'The AI provider could not complete this request. Please try again.',
        requestId,
      );
  }
});
