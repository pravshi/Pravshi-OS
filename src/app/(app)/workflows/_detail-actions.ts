'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import { getWorkflow, listExecutions } from '@/lib/workflows/service';
import { WORKFLOW_PERMISSIONS } from './_permissions';
import type { Workflow, WorkflowResult } from './_types';
import type { ExecutionPage } from '@/lib/workflows/service';

/**
 * /workflows detail-track Server Actions (A14) — authorize first, always.
 *
 * The builder track (A13) owns ./_actions.ts (list/create/update); this
 * module carries the detail page's reads so the two tracks never edit the
 * same file. Same convention: untrusted input, requirePermission() first,
 * failures return the actionError() envelope (data, not a throw).
 *
 * Mutations from the detail page (activate/pause/execute/delete) call the
 * REST API directly from client components so they can distinguish 400
 * (invalid state) from 403/404 for their toasts.
 */

/** Boundary UUID check: malformed ids fail before the service ever sees them. */
const uuid = z.string().uuid();

const executionsInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** GET one workflow definition — invisible/missing/foreign → NOT_FOUND envelope. */
export async function getWorkflowAction(id: string): Promise<WorkflowResult<Workflow>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: WORKFLOW_PERMISSIONS.workflows.view,
    });
    return await getWorkflow(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}

/** GET execution history for one workflow — newest first, paged. */
export async function listWorkflowExecutionsAction(
  id: string,
  input: unknown,
): Promise<WorkflowResult<ExecutionPage>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: WORKFLOW_PERMISSIONS.workflows.view,
    });
    return await listExecutions(authorization, uuid.parse(id), executionsInput.parse(input ?? {}));
  } catch (error) {
    return actionError(error);
  }
}
