/**
 * /api/work/tasks/[id] — task detail.
 *
 * No task-level handlers live here yet; the task's sub-resources are mounted
 * under this path instead:
 *   /api/work/tasks/[id]/reminders   (GET/POST, the caller's reminders)
 *   /api/work/tasks/[id]/move        (reposition the task)
 */

export const dynamic = 'force-dynamic';
