'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import { unarchiveProject } from '@/lib/work/projects';
import type { Project, WorkResult } from '../_types';

/**
 * unarchiveProjectAction — restore an archived project (Phase 4 UI fix).
 *
 * Companion to deleteProjectAction in ../_actions.ts, which performs the
 * archive side (projects are never hard-deleted). Kept as its own module in
 * _components/ so the UI fix ships without touching the shared actions file;
 * the actions owner may fold it into _actions.ts later. requirePermission is
 * the first statement, per the repo's authorization-first convention.
 */
const uuid = z.string().uuid();

export async function unarchiveProjectAction(id: string): Promise<WorkResult<Project>> {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'projects.edit',
    });
    return await unarchiveProject(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}
