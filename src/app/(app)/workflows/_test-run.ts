/**
 * Client helper for the builder's manual test-run.
 *
 * Calls POST /api/workflows/[id]/execute directly (not via a server action)
 * so the caller sees the real HTTP status: 202 (accepted) vs 400 (draft /
 * paused / deferred trigger) vs 403/404 (lost access). Only ACTIVE workflows
 * execute — a DRAFT workflow's test-run returns 400 INVALID_REQUEST.
 */

export interface TestRunOutcome {
  ok: boolean;
  status: number;
  executionId: string | null;
  executionStatus: string | null;
  /** Server-supplied message on failure (envelope or plain error). */
  error: string | null;
}

function readErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const envelope = record.error;
  if (typeof envelope === 'object' && envelope !== null) {
    const message = (envelope as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (typeof record.message === 'string' && record.message.length > 0) {
    return record.message;
  }
  return null;
}

export async function executeWorkflowViaApi(id: string, input?: unknown): Promise<TestRunOutcome> {
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input === undefined ? {} : { input }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        executionId: null,
        executionStatus: null,
        error: readErrorMessage(body) ?? `Test run failed (HTTP ${res.status})`,
      };
    }
    const record = (body ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      status: res.status,
      executionId: typeof record.executionId === 'string' ? record.executionId : null,
      executionStatus: typeof record.status === 'string' ? record.status : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      executionId: null,
      executionStatus: null,
      error: error instanceof Error ? error.message : 'Network error — check your connection.',
    };
  }
}
