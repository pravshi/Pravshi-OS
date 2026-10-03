/**
 * /api/work/projects/[id] — project detail.
 *
 * No project-level handlers live here yet; the project's sub-resources are
 * mounted under this path instead:
 *   /api/work/projects/[id]/link-deal  (POST/DELETE, link or unlink a CRM deal)
 *   /api/work/projects/[id]/members    (project membership)
 *   /api/work/projects/[id]/tasks      (tasks on the project)
 */

export const dynamic = 'force-dynamic';
