import { z } from 'zod';

/**
 * Work Management input validation (Phase 4). Every untrusted value — REST
 * bodies and query strings — is validated here, at the boundary, before a
 * service function touches the database.
 *
 * ── COLUMN CONTRACT WITH MIGRATION 0042 ─────────────────────────────────────────
 *
 * The services in this module address the tables with raw SQL, so a column-name
 * drift between this file and 0042 is a runtime error, not a type error. The
 * columns per table:
 *
 *   work_projects:  id, org_id, name, description, is_archived,
 *                   created_by, created_at, updated_at, deleted_at
 *   work_tasks:     id, org_id, project_id, title, description,
 *                   status, priority, due_date, assignee_person_id,
 *                   created_by, created_at, updated_at, deleted_at
 *   project_members: id, org_id, project_id, person_id, role_in_project,
 *                   added_by, added_at
 *                   (per the master blueprint §15; the 0042 migration owns the
 *                   exact DDL — the service only reads/writes these columns)
 *
 * Wire contract: the API speaks camelCase; SQL aliases translate
 * (due_date AS "dueDate"). If 0042 names a column differently, update the SQL
 * in projects.ts / tasks.ts only.
 *
 * Permission keys (seeded by migration 0008, grants landing in 0042):
 *   projects.view / create / edit / delete / manage_members
 *   tasks.view / create / edit / assign / delete / comment
 * requirePermission() fails closed on an unknown key, so the routes use these
 * exact keys — never invented ones.
 */

const uuid = z.string().uuid();

/** Task lifecycle. Mirrors the work_tasks.status CHECK in migration 0042. */
export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskStatusSchema = z.enum(TASK_STATUSES);

/** Task priority. Mirrors the work_tasks.priority CHECK in migration 0042. */
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional();

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be a real calendar date');

const sortOrder = z.enum(['asc', 'desc']);

/** List pagination. Offset-based per the API contract; hard cap at 100. */
export const ListQuerySchema = z.strictObject({
  search: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

/** Paginated list envelope returned by every list* service. */
export type Page<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
};

// ── Projects ───────────────────────────────────────────────────────────────────

export const CreateProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  description: nullableText(2000),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/** Partial update: every field optional, at least one required. */
export const UpdateProjectSchema = CreateProjectSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'at least one field is required',
);
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

/** Sort allowlist for project lists — anything else is a 400, never SQL. */
export const PROJECT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
export type ProjectSortField = (typeof PROJECT_SORT_FIELDS)[number];

export const ListProjectsQuerySchema = ListQuerySchema.extend({
  includeArchived: z
    .enum(['true', 'false'])
    .transform((s) => s === 'true')
    .default(false),
  sort: z.enum(PROJECT_SORT_FIELDS).default('name'),
  order: sortOrder.default('asc'),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

// ── Tasks ──────────────────────────────────────────────────────────────────────

export const CreateTaskSchema = z.strictObject({
  projectId: uuid.nullable().optional(),
  title: z.string().trim().min(1).max(255),
  description: nullableText(2000),
  status: TaskStatusSchema.default('todo'),
  priority: TaskPrioritySchema.default('medium'),
  dueDate: dateString.nullable().optional(),
  assigneePersonId: uuid.nullable().optional(),
  /**
   * Subtask support (Phase 4): a task with parentTaskId set is a subtask.
   * One level only — a subtask may never be a parent (enforced in tasks.ts).
   */
  parentTaskId: uuid.nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/**
 * Partial update: every field optional, at least one required.
 *
 * No .default() here: in zod v4 a default inside partial() would apply to
 * omitted keys and clobber the stored value on unrelated updates (P1). Omitting
 * status/priority leaves the columns untouched; the create-time defaults live
 * only on CreateTaskSchema.
 */
export const UpdateTaskSchema = CreateTaskSchema.partial()
  .extend({
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

/** Sort allowlist for task lists — anything else is a 400, never SQL. */
export const TASK_SORT_FIELDS = [
  'title',
  'status',
  'priority',
  'dueDate',
  'createdAt',
  'updatedAt',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const ListTasksQuerySchema = ListQuerySchema.extend({
  projectId: uuid.optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assigneePersonId: uuid.optional(),
  sort: z.enum(TASK_SORT_FIELDS).default('updatedAt'),
  order: sortOrder.default('desc'),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

/**
 * Kanban move payload. status is the ONLY field this endpoint may change —
 * project_id is deliberately absent: cross-project moves are forbidden here.
 * Moving a task to another project is PATCH /api/work/tasks/[id] with
 * projectId, which validates same-org membership (plus the DB trigger
 * backstop, 42501 → 400).
 */
export const MoveTaskSchema = z.strictObject({
  status: TaskStatusSchema,
});
export type MoveTaskInput = z.infer<typeof MoveTaskSchema>;

// ── Project members ────────────────────────────────────────────────────────────

export const AddProjectMemberSchema = z.strictObject({
  personId: uuid,
  /**
   * Free-form project role (e.g. manager / member / viewer). Omitted → the
   * column is left out of the INSERT so any database default applies. A 23502
   * on the write surfaces as 400 roleInProject-required.
   */
  roleInProject: z.string().trim().min(1).max(64).optional(),
});
export type AddProjectMemberInput = z.infer<typeof AddProjectMemberSchema>;

// ── Wire types ─────────────────────────────────────────────────────────────────

export type Project = {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  /** The CRM deal this project delivers (Deal → Project → Tasks), or null. */
  dealId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectListRow = Project & {
  taskCount: number;
  openTaskCount: number;
};

export type Task = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** YYYY-MM-DD, or null. */
  dueDate: string | null;
  assigneePersonId: string | null;
  assigneeName: string | null;
  /** Null for top-level tasks; set for subtasks. Never nested deeper than one level. */
  parentTaskId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** A subtask is a task whose parentTaskId is set. */
export type Subtask = Task;

/** A task together with its direct subtasks. */
export type TaskWithSubtasks = Task & {
  subtasks: Task[];
};

export type ProjectMember = {
  personId: string;
  name: string | null;
  workEmail: string | null;
  roleInProject: string | null;
  addedBy: string | null;
  addedAt: string;
};

export type MoveTaskResult = {
  ok: true;
  taskId: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
};

// ── Deal ↔ project link ──────────────────────────────────────────────────────

/** POST /api/work/projects/[id]/link-deal body: the deal to link. */
export const LinkDealSchema = z.strictObject({
  dealId: uuid,
});
export type LinkDealInput = z.infer<typeof LinkDealSchema>;

/** The minimal deal a project link needs to render. */
export type DealLinkSummary = {
  id: string;
  title: string;
  value: string | null;
  currency: string;
  stage: string;
};

/** The minimal project the deal side needs to render. */
export type ProjectLinkSummary = {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
};
