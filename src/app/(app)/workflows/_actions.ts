'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import { createWorkflow, listWorkflows, updateWorkflow } from '@/lib/workflows/service';
import { WORKFLOW_PERMISSIONS } from './_permissions';
import type { Workflow, WorkflowPage, WorkflowResult } from './_types';

/**
 * /workflows Server Actions — authorize first, always.
 *
 * Same convention as src/app/(app)/work/_actions.ts: each action takes
 * untrusted input, calls requirePermission() as its first statement, then
 * delegates to the service layer. Failures return the actionError()
 * envelope (data, not a throw).
 *
 * The builder's manual test-run and the detail page's execute control call
 * POST /api/workflows/[id]/execute directly (see ./_test-run.ts) so they
 * can distinguish 400 (invalid state) from 403/404 for their toasts.
 */

/** Boundary UUID check: malformed ids fail before the service ever sees them. */
const uuid = z.string().uuid();

/** GET list — search + status filter follow the work page pattern (URL params). */
export async function listWorkflowsAction(input: unknown): Promise<WorkflowResult<WorkflowPage>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: WORKFLOW_PERMISSIONS.workflows.view,
    });
    return await listWorkflows(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

/** Create a workflow definition (always starts as DRAFT — activation is a separate, gated step). */
export async function createWorkflowAction(input: unknown): Promise<WorkflowResult<Workflow>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: WORKFLOW_PERMISSIONS.workflows.create,
    });
    return await createWorkflow(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

/**
 * Update a workflow definition (bound with `.bind(null, id)` for edits —
 * never an inline closure). Saving bumps the stored version.
 */
export async function updateWorkflowAction(
  id: string,
  input: unknown,
): Promise<WorkflowResult<Workflow>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: WORKFLOW_PERMISSIONS.workflows.edit,
    });
    return await updateWorkflow(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}
