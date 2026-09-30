'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import { listDeals } from '@/lib/crm/deals';
import {
  listPipelines,
  createPipeline,
  getPipeline,
  updatePipeline,
  deletePipeline,
  listStages,
  createStage,
  updateStage,
  getForecast,
  getVelocity,
} from '@/lib/crm/pipelines';
import { PIPELINE_STAGES_MANAGE } from '../_permissions';

/**
 * /crm/pipelines Server Actions — authorize first, always.
 *
 * Same envelope convention as src/app/(app)/crm/actions.ts: each action takes
 * untrusted `input: unknown`; the service layer validates with zod; failures
 * return the actionError() envelope (data, not a throw).
 *
 * The interactive deal-move deliberately does NOT go through an action: the
 * kanban calls POST /api/crm/deals/:id/move directly so it can distinguish
 * 400 (invalid target) from 403/404 (lost access) for its toasts.
 */

/** Boundary UUID check (A3): malformed ids fail before PostgreSQL ever sees them. */
const uuid = z.string().uuid();

// ── Pipelines ──────────────────────────────────────────────────────────────────

export async function listPipelinesAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.view',
    });
    return await listPipelines(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function createPipelineAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.create',
    });
    return await createPipeline(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getPipelineAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.view',
    });
    return await getPipeline(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}

export async function updatePipelineAction(id: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.edit',
    });
    return await updatePipeline(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deletePipelineAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.delete',
    });
    await deletePipeline(authorization, uuid.parse(id));
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

// ── Stages ─────────────────────────────────────────────────────────────────────

export async function listStagesAction(pipelineId: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.view',
    });
    return await listStages(authorization, uuid.parse(pipelineId));
  } catch (error) {
    return actionError(error);
  }
}

export async function createStageAction(pipelineId: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: PIPELINE_STAGES_MANAGE,
    });
    return await createStage(authorization, uuid.parse(pipelineId), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateStageAction(stageId: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: PIPELINE_STAGES_MANAGE,
    });
    return await updateStage(authorization, uuid.parse(stageId), input);
  } catch (error) {
    return actionError(error);
  }
}

// ── Analytics ──────────────────────────────────────────────────────────────────

export async function getForecastAction(pipelineId: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.view',
    });
    return await getForecast(authorization, uuid.parse(pipelineId));
  } catch (error) {
    return actionError(error);
  }
}

export async function getVelocityAction(pipelineId: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'pipelines.view',
    });
    return await getVelocity(authorization, uuid.parse(pipelineId));
  } catch (error) {
    return actionError(error);
  }
}

// ── Board deals ────────────────────────────────────────────────────────────────
//
// API gap (documented, not fixed): GET /api/crm/deals has no pipelineId filter
// and Deal rows carry no pipelineId/pipelineStageId, so the board loads the
// visible deals (capped at 100) and groups/filters them client-side once the
// fields exist on the wire.
//
// NOTE: the interactive move deliberately does NOT go through a server action.
// The kanban calls POST /api/crm/deals/:id/move directly so it can distinguish
// 400 (invalid target → "Cannot move there") from 403/404 (access lost → toast
// + refetch). Server actions mask service INVALID_REQUEST errors behind the
// generic internal-error envelope, so they cannot drive those toasts.

const BOARD_DEAL_LIMIT = 100;

export async function listBoardDealsAction() {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.view',
    });
    return await listDeals(authorization, { limit: BOARD_DEAL_LIMIT, offset: 0 });
  } catch (error) {
    return actionError(error);
  }
}
