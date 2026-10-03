import { z, ZodError } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { deleteReminder } from '@/lib/work/reminders';

/**
 * /api/work/tasks/[id]/reminders/[reminderId] — delete one of the caller's
 * own reminders (Phase 4 V1).
 * DELETE tasks.edit → 200 { ok: true }. Only the reminder's owner can delete
 *        it; an invisible or foreign reminder conceals as NOT_FOUND.
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

export const DELETE = withPermission<{ id: string; reminderId: string }>(
  { permission: 'tasks.edit' },
  async (_request, authorization, params) => {
    try {
      const taskId = z.string().uuid().parse(params.id);
      const reminderId = z.string().uuid().parse(params.reminderId);
      await deleteReminder(authorization, taskId, reminderId);
      return Response.json({ ok: true }, { headers: NO_STORE });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
