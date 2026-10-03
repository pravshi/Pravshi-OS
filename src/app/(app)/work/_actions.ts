'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  updateProject,
} from '@/lib/work/projects';
import {
  createTask,
  deleteTask,
  getTask,
  listMyTasks,
  listProjectTasks,
  moveTask,
  updateTask,
} from '@/lib/work/tasks';
import {
  TASK_STATUSES,
  type MoveTaskResult,
  type Project,
  type TaskStatus,
  type WorkPage,
  type WorkResult,
  type WorkTask,
} from './_types';

/**
 * /work Server Actions — authorize first, always.
 *
 * Same convention as src/app/(app)/crm/pipelines/_actions.ts: each action
 * takes untrusted input, calls requirePermission() as its first statement,
 * then delegates to the service layer. Failures return the actionError()
 * envelope (data, not a throw).
 *
 * The interactive board moves deliberately do NOT go through actions: the
 * kanban calls POST /api/work/tasks/:id/move directly so it can distinguish
 * 400 (invalid target) from 403/404 (lost access) for its toasts.
 */

/** Boundary UUID check: malformed ids fail before the service ever sees them. */
const uuid = z.string().uuid();

const moveTaskInput = z.object({ status: z.enum(TASK_STATUSES) });

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjectsAction(
  input: unknown,
): Promise<WorkResult<WorkPage<Project>>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'projects.view',
    });
    return await listProjects(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getProjectAction(id: string): Promise<WorkResult<Project>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'projects.view',
    });
    return await getProject(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}

export async function createProjectAction(input: unknown): Promise<WorkResult<Project>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'projects.create',
    });
    return await createProject(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateProjectAction(
  id: string,
  input: unknown,
): Promise<WorkResult<Project>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'projects.edit',
    });
    return await updateProject(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteProjectAction(id: string): Promise<WorkResult<{ ok: boolean }>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'projects.edit',
    });
    await archiveProject(authorization, uuid.parse(id));
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export async function listProjectTasksAction(
  projectId: string,
  input?: unknown,
): Promise<WorkResult<WorkPage<WorkTask>>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.view',
    });
    return await listProjectTasks(authorization, uuid.parse(projectId), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function listMyTasksAction(
  input?: unknown,
): Promise<WorkResult<WorkPage<WorkTask>>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.view',
    });
    return await listMyTasks(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getTaskAction(id: string): Promise<WorkResult<WorkTask>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.view',
    });
    return await getTask(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}

export async function createTaskAction(input: unknown): Promise<WorkResult<WorkTask>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.create',
    });
    return await createTask(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateTaskAction(
  id: string,
  input: unknown,
): Promise<WorkResult<WorkTask>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.edit',
    });
    return await updateTask(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteTaskAction(id: string): Promise<WorkResult<{ ok: boolean }>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.delete',
    });
    await deleteTask(authorization, uuid.parse(id));
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

/**
 * The interactive board move. The client kanban deliberately calls
 * POST /api/work/tasks/:id/move directly (like the pipeline board does) so it
 * can distinguish 400 (invalid target) from 403/404 (lost access) for its
 * toasts; this action exists for non-interactive callers.
 */
export async function moveTaskAction(
  id: string,
  input: unknown,
): Promise<WorkResult<MoveTaskResult>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.edit',
    });
    const parsed = moveTaskInput.parse(input);
    const result = await moveTask(authorization, uuid.parse(id), parsed);
    if (typeof result === 'object' && result !== null && 'status' in result) {
      return { status: (result as { status: TaskStatus }).status };
    }
    return { status: parsed.status };
  } catch (error) {
    return actionError(error);
  }
}
