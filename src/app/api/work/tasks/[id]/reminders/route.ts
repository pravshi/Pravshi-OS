import { z, ZodError } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { CreateReminderSchema, createReminder, listTaskReminders } from '@/lib/work/reminders';

/**
 * /api/work/tasks/[id]/reminders — task self-reminders (Phase 4 V1).
 * GET  tasks.view → the caller's own reminders on the task, soonest first
 * POST tasks.edit → create a reminder (assignee or creator only — enforced in
 *      the service; the body speaks camelCase)
 *
 * Reminders are stored only; delivery belongs to Phase 6 automation, which
 * flips is_sent. Input validation failures are 400 INVALID_REQUEST; anything
 * else propagates to withPermission()'s error envelope.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function invalidRequestResponse(error: unknown): Response | null {
  if (!(error instanceof ZodError)) return null;
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return Response.json(
    { error: 'INVALID_REQUEST', message: `${where}${first?.message ?? 'invalid input'}` },
    { status: 400, headers: NO_STORE },
  );
}

export const GET = withPermission<{ id: string }>(
  { permission: 'tasks.view' },
  async (_request, authorization, params) => {
    try {
      const taskId = z.string().uuid().parse(params.id);
      const reminders = await listTaskReminders(authorization, taskId);
      return Response.json(reminders, { headers: NO_STORE });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission<{ id: string }>(
  { permission: 'tasks.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const taskId = z.string().uuid().parse(params.id);
      const input = CreateReminderSchema.parse(body);
      const reminder = await createReminder(authorization, taskId, input);
      return Response.json(reminder, { status: 201, headers: NO_STORE });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
