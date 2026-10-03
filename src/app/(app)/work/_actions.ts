'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { actionError } from '@/lib/authz/http';
import type { ErrorEnvelope } from '@/lib/authz/errors';
import {
  TASK_STATUSES,
  type MoveTaskResult,
  type Project,
  type TaskStatus,
  type WorkPage,
  type WorkResult,
  type WorkTask,
  isErrorEnvelope,
} from './_types';

/**
 * /work Server Actions — thin proxies over the /api/work/* REST routes.
 *
 * The Phase 4 API track owns authorization, validation, and persistence; the
 * UI owns presentation. Every action forwards the request cookies so the API
 * sees the caller's session, then returns either the API's payload or an
 * error envelope (data, never a throw) — the same convention as the CRM
 * actions.
 *
 * Reads accept both `Page<T>` ({ rows, total, limit, offset }) and bare `T[]`
 * list bodies, whichever the API ships.
 */

/** Boundary UUID check: malformed ids fail before any fetch is attempted. */
const uuid = z.string().uuid();

const moveTaskInput = z.object({ status: z.enum(TASK_STATUSES) });

/** Absolute URL of this app, derived from the incoming request headers. */
async function apiUrl(path: string): Promise<string> {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}${path}`;
}

class ApiFailure extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`Work API request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const h = await headers();
  const url = await apiUrl(path);
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
      cookie: h.get('cookie') ?? '',
    },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure(res.status, body);
  return body;
}

/** The API routes build envelopes field-by-field; pass them through untouched. */
function envelopeFor(error: unknown): ErrorEnvelope {
  if (error instanceof ApiFailure) {
    if (isErrorEnvelope(error.body)) return error.body;
    if (error.status === 401)
      return {
        error: { code: 'UNAUTHENTICATED', message: 'Your session expired. Please sign in again.' },
      };
    if (error.status === 403)
      return {
        error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' },
      };
    if (error.status === 404)
      return { error: { code: 'NOT_FOUND', message: 'That record was not found.' } };
    return {
      error: {
        code: 'INTERNAL',
        message: 'The work service returned an unexpected error. Please try again.',
      },
    };
  }
  return actionError(error);
}

/** Normalize a list body into a WorkPage regardless of envelope shape. */
function toWorkPage<T>(body: unknown): WorkPage<T> {
  if (Array.isArray(body)) {
    return { rows: body as T[], total: body.length, limit: body.length, offset: 0 };
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    'rows' in body &&
    Array.isArray((body as { rows: unknown }).rows)
  ) {
    const page = body as WorkPage<T>;
    return {
      rows: page.rows ?? [],
      total: page.total ?? page.rows.length,
      limit: page.limit ?? page.rows.length,
      offset: page.offset ?? 0,
    };
  }
  return { rows: [], total: 0, limit: 0, offset: 0 };
}

function jsonBody(input: unknown): string {
  return JSON.stringify(input ?? {});
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjectsAction(input: unknown): Promise<WorkResult<WorkPage<Project>>> {
  try {
    const query =
      typeof input === 'object' && input !== null
        ? (input as { limit?: number; offset?: number; status?: string })
        : {};
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    const body = await apiFetch(`/api/work/projects${qs ? `?${qs}` : ''}`);
    return toWorkPage<Project>(body);
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function getProjectAction(id: string): Promise<WorkResult<Project>> {
  try {
    const body = await apiFetch(`/api/work/projects/${uuid.parse(id)}`);
    return body as Project;
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function createProjectAction(input: unknown): Promise<WorkResult<Project>> {
  try {
    const body = await apiFetch('/api/work/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(input),
    });
    return body as Project;
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function updateProjectAction(
  id: string,
  input: unknown,
): Promise<WorkResult<Project>> {
  try {
    const body = await apiFetch(`/api/work/projects/${uuid.parse(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(input),
    });
    return body as Project;
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function deleteProjectAction(id: string): Promise<WorkResult<{ ok: boolean }>> {
  try {
    await apiFetch(`/api/work/projects/${uuid.parse(id)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (error) {
    return envelopeFor(error);
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export async function listProjectTasksAction(
  projectId: string,
  input?: unknown,
): Promise<WorkResult<WorkPage<WorkTask>>> {
  try {
    const query =
      typeof input === 'object' && input !== null
        ? (input as { limit?: number; offset?: number; status?: string })
        : {};
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    const body = await apiFetch(
      `/api/work/projects/${uuid.parse(projectId)}/tasks${qs ? `?${qs}` : ''}`,
    );
    return toWorkPage<WorkTask>(body);
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function listMyTasksAction(input?: unknown): Promise<WorkResult<WorkPage<WorkTask>>> {
  try {
    const query =
      typeof input === 'object' && input !== null
        ? (input as { limit?: number; offset?: number; status?: string })
        : {};
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    const body = await apiFetch(`/api/work/tasks/mine${qs ? `?${qs}` : ''}`);
    return toWorkPage<WorkTask>(body);
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function getTaskAction(id: string): Promise<WorkResult<WorkTask>> {
  try {
    const body = await apiFetch(`/api/work/tasks/${uuid.parse(id)}`);
    return body as WorkTask;
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function createTaskAction(input: unknown): Promise<WorkResult<WorkTask>> {
  try {
    const body = await apiFetch('/api/work/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(input),
    });
    return body as WorkTask;
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function updateTaskAction(id: string, input: unknown): Promise<WorkResult<WorkTask>> {
  try {
    const body = await apiFetch(`/api/work/tasks/${uuid.parse(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(input),
    });
    return body as WorkTask;
  } catch (error) {
    return envelopeFor(error);
  }
}

export async function deleteTaskAction(id: string): Promise<WorkResult<{ ok: boolean }>> {
  try {
    await apiFetch(`/api/work/tasks/${uuid.parse(id)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (error) {
    return envelopeFor(error);
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
    const parsed = moveTaskInput.parse(input);
    const body = await apiFetch(`/api/work/tasks/${uuid.parse(id)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (typeof body === 'object' && body !== null && 'status' in body) {
      return { status: (body as { status: TaskStatus }).status };
    }
    return { status: parsed.status };
  } catch (error) {
    return envelopeFor(error);
  }
}
