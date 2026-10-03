'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import { getTaskWithSubtasks, listSubtasks, createSubtask, setTaskStatus } from '@/lib/work/tasks';
import type { TaskStatus } from '@/lib/work/schema';

/** Boundary UUID check: malformed ids fail before PostgreSQL ever sees them. */
const uuid = z.string().uuid();

/**
 * /work/subtasks Server Actions — authorize first, always.
 *
 * Each action takes untrusted arguments; the service layer validates them with
 * zod before any database access. Failures return the actionError() envelope.
 * Permission keys: tasks.view for reads, tasks.create for creation, tasks.edit
 * for the completion toggle.
 */

export async function listSubtasksAction(parentId: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.view',
    });
    return await listSubtasks(authorization, uuid.parse(parentId), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getTaskWithSubtasksAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.view',
    });
    return await getTaskWithSubtasks(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}

export async function createSubtaskAction(parentId: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.create',
    });
    return await createSubtask(authorization, uuid.parse(parentId), input);
  } catch (error) {
    return actionError(error);
  }
}

/** The subtask checkbox toggle: 'completed' ⇄ 'todo'. */
export async function setSubtaskStatusAction(subtaskId: string, status: TaskStatus) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'tasks.edit',
    });
    return await setTaskStatus(authorization, uuid.parse(subtaskId), { status });
  } catch (error) {
    return actionError(error);
  }
}
