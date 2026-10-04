'use client';

import { WorkflowBuilder } from './WorkflowBuilder';
import type { CreateWorkflowInput, Workflow, WorkflowResult } from '../_types';

/**
 * Server-returned authorization failure codes (mirrors AuthorizationCode in
 * src/lib/authz/errors.ts). Duplicated here — never imported — because the
 * require-permission-first guard forbids client components from importing
 * anything under @/lib/authz or @/lib/audit, even type-only.
 */
type AuthorizationFailureCode =
  'UNAUTHENTICATED' | 'FORBIDDEN' | 'SCOPE_DENIED' | 'STEP_UP_REQUIRED' | 'NOT_FOUND';

/**
 * EditWorkflowClient — hosts A13's WorkflowBuilder in edit mode.
 *
 * The builder drives the whole save flow itself (validation, toasts,
 * navigation back to the detail page); this wrapper only adapts its onSave
 * contract — (CreateWorkflowInput) => Promise<WorkflowResult<Workflow>> — to
 * the REST PATCH endpoint so failures surface as error envelopes the builder
 * already knows how to display. Saving bumps the workflow version
 * server-side.
 */
function readErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const envelope = record.error;
  if (typeof envelope === 'object' && envelope !== null) {
    const message = (envelope as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  return null;
}

/**
 * Nit-6: surface the server's error code instead of synthesizing INTERNAL
 * for every failure. Authorization failures arrive as
 * { error: { code, message, requestId } } and their code is preserved;
 * anything else (including the { error: 'INVALID_REQUEST', message } 400
 * shape, which the ErrorEnvelope code union cannot express) stays INTERNAL —
 * the message still carries the detail.
 */
function readErrorCode(body: unknown): AuthorizationFailureCode | 'INTERNAL' {
  if (typeof body !== 'object' || body === null) return 'INTERNAL';
  const envelope = (body as Record<string, unknown>).error;
  if (typeof envelope === 'object' && envelope !== null) {
    const code = (envelope as Record<string, unknown>).code;
    if (
      code === 'UNAUTHENTICATED' ||
      code === 'FORBIDDEN' ||
      code === 'SCOPE_DENIED' ||
      code === 'STEP_UP_REQUIRED' ||
      code === 'NOT_FOUND'
    ) {
      return code;
    }
  }
  return 'INTERNAL';
}

export function EditWorkflowClient({ initialWorkflow }: { initialWorkflow: Workflow }) {
  async function handleSave(input: CreateWorkflowInput): Promise<WorkflowResult<Workflow>> {
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(initialWorkflow.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = readErrorMessage(body) ?? 'Could not save this workflow.';
        return {
          error: {
            code: readErrorCode(body),
            message,
          },
        };
      }
      return body as Workflow;
    } catch {
      return {
        error: { code: 'INTERNAL', message: 'The save request failed. Please try again.' },
      };
    }
  }

  return (
    <WorkflowBuilder initial={initialWorkflow} onSave={handleSave} submitLabel="Save changes" />
  );
}
