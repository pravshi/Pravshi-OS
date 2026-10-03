import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { tryImport } from './helpers';

/**
 * Phase 4 — zod schema unit tests for the work module. No DB, no env needed:
 * src/lib/work/schema.ts must import only zod (the same rule the CRM schema
 * follows), so this file stays a pure unit test.
 *
 * ── Contract this file pins ──────────────────────────────────────────────────
 * The API agent had not written src/lib/work/schema.ts when these tests were
 * authored, so the module is loaded with a best-effort dynamic import and the
 * whole suite SKIPS until it exists. When it lands, these tests pin its
 * surface; if the API agent names things differently the suite fails loudly
 * and the lead reconciles.
 *
 * Expected exports from @/lib/work/schema:
 *  - TaskStatusSchema:   enum ['todo', 'in_progress', 'done']
 *  - TaskPrioritySchema: enum ['low', 'medium', 'high', 'urgent']
 *  - CreateProjectSchema: { name: non-empty trimmed string; description?: string }
 *  - UpdateProjectSchema: partial, isArchived?: boolean, non-empty refine, NO default leak
 *  - CreateTaskSchema: { title: non-empty trimmed; description?; status default 'todo';
 *      priority default 'medium'; projectId?: uuid; assigneePersonId?: uuid; dueDate? }
 *  - UpdateTaskSchema: partial, non-empty refine, NO default leak
 *  - MoveTaskSchema: { status?; projectId? } — at least one required
 */

interface WorkSchemaModule {
  TaskStatusSchema: ZodTypeAny;
  TaskPrioritySchema: ZodTypeAny;
  CreateProjectSchema: ZodTypeAny;
  UpdateProjectSchema: ZodTypeAny;
  CreateTaskSchema: ZodTypeAny;
  UpdateTaskSchema: ZodTypeAny;
  MoveTaskSchema: ZodTypeAny;
}

const schema = await tryImport<WorkSchemaModule>('@/lib/work/schema');

/** parse() on ZodTypeAny returns unknown; tests need field access. */
const parseObj = (s: ZodTypeAny, input: unknown): Record<string, unknown> =>
  s.parse(input) as Record<string, unknown>;

describe.skipIf(!schema)('work zod schemas', () => {
  // The callback body runs at collection even when skipped; the schemas are
  // only touched by tests that never run in that case.
  const {
    TaskStatusSchema,
    TaskPrioritySchema,
    CreateProjectSchema,
    UpdateProjectSchema,
    CreateTaskSchema,
    UpdateTaskSchema,
    MoveTaskSchema,
  } = schema ?? ({} as WorkSchemaModule);

  describe('TaskStatusSchema', () => {
    it.each(['todo', 'in_progress', 'done'])('accepts %p', (status) => {
      expect(TaskStatusSchema.parse(status)).toBe(status);
    });

    it.each(['TODO', 'In_Progress', 'archived', '', 'done '] as const)('rejects %p', (status) => {
      expect(() => TaskStatusSchema.parse(status)).toThrow();
    });
  });

  describe('TaskPrioritySchema', () => {
    it.each(['low', 'medium', 'high', 'urgent'])('accepts %p', (priority) => {
      expect(TaskPrioritySchema.parse(priority)).toBe(priority);
    });

    it.each(['LOW', 'critical', 'p0', '', ' medium'] as const)('rejects %p', (priority) => {
      expect(() => TaskPrioritySchema.parse(priority)).toThrow();
    });
  });

  describe('CreateTaskSchema', () => {
    it('requires a non-blank title', () => {
      expect(() => parseObj(CreateTaskSchema, {})).toThrow();
      expect(() => parseObj(CreateTaskSchema, { title: '' })).toThrow();
      expect(() => parseObj(CreateTaskSchema, { title: '   ' })).toThrow();
      expect(parseObj(CreateTaskSchema, { title: '  Ship it  ' }).title).toBe('Ship it');
    });

    it('applies create-time defaults for status and priority', () => {
      const parsed = parseObj(CreateTaskSchema, { title: 'Brand-new task' });
      expect(parsed.status).toBe('todo');
      expect(parsed.priority).toBe('medium');
    });

    it('accepts explicit status, priority, project, assignee, and due date', () => {
      const projectId = '11111111-1111-4111-8111-111111111111';
      const assigneeId = '22222222-2222-4222-8222-222222222222';
      const parsed = parseObj(CreateTaskSchema, {
        title: 'Full task',
        description: 'details',
        status: 'in_progress',
        priority: 'urgent',
        projectId: projectId,
        assigneePersonId: assigneeId,
        dueDate: '2026-12-31',
      });
      expect(parsed.status).toBe('in_progress');
      expect(parsed.priority).toBe('urgent');
      expect(parsed.projectId).toBe(projectId);
      expect(parsed.assigneePersonId).toBe(assigneeId);
      expect(parsed.description).toBe('details');
    });

    it('rejects invalid status/priority at the boundary, not at the DB', () => {
      expect(() => parseObj(CreateTaskSchema, { title: 'x', status: 'donee' })).toThrow();
      expect(() => parseObj(CreateTaskSchema, { title: 'x', priority: 'critical' })).toThrow();
    });

    it('rejects non-uuid project and assignee ids', () => {
      expect(() => parseObj(CreateTaskSchema, { title: 'x', projectId: 'not-a-uuid' })).toThrow();
      expect(() =>
        parseObj(CreateTaskSchema, { title: 'x', assigneePersonId: 'not-a-uuid' }),
      ).toThrow();
    });
  });

  describe('UpdateTaskSchema does not inject create-time defaults', () => {
    it('an update omitting status and priority leaves both keys absent', () => {
      const parsed = parseObj(UpdateTaskSchema, { title: 'Renamed task' });
      expect(parsed).toEqual({ title: 'Renamed task' });
      expect('status' in parsed).toBe(false);
      expect('priority' in parsed).toBe(false);
    });

    it('create-time defaults still apply on CreateTaskSchema (regression anchor)', () => {
      const parsed = parseObj(CreateTaskSchema, { title: 't' });
      expect(parsed.status).toBe('todo');
      expect(parsed.priority).toBe('medium');
    });

    it('an explicit status is accepted but does not pull in a priority', () => {
      const parsed = parseObj(UpdateTaskSchema, { status: 'done' });
      expect(parsed.status).toBe('done');
      expect('priority' in parsed).toBe(false);
    });

    it('an explicit priority is accepted but does not pull in a status', () => {
      const parsed = parseObj(UpdateTaskSchema, { priority: 'high' });
      expect(parsed.priority).toBe('high');
      expect('status' in parsed).toBe(false);
    });

    it('an empty update is still rejected (non-empty refine intact)', () => {
      expect(() => parseObj(UpdateTaskSchema, {})).toThrow();
    });

    it('invalid status/priority are rejected on update too', () => {
      expect(() => parseObj(UpdateTaskSchema, { status: 'nope' })).toThrow();
      expect(() => parseObj(UpdateTaskSchema, { priority: 'nope' })).toThrow();
    });

    it('a task can be unassigned from its project via explicit null', () => {
      const parsed = parseObj(UpdateTaskSchema, { projectId: null });
      expect(parsed.projectId).toBeNull();
    });
  });

  describe('CreateProjectSchema', () => {
    it('requires a non-blank name and trims it', () => {
      expect(() => parseObj(CreateProjectSchema, {})).toThrow();
      expect(() => parseObj(CreateProjectSchema, { name: '  ' })).toThrow();
      expect(parseObj(CreateProjectSchema, { name: '  Website  ' }).name).toBe('Website');
    });

    it('accepts an optional description', () => {
      const parsed = parseObj(CreateProjectSchema, { name: 'P', description: 'd' });
      expect(parsed.description).toBe('d');
      expect(parseObj(CreateProjectSchema, { name: 'P' }).description).toBeUndefined();
    });

    it('does not inject isArchived on create', () => {
      const parsed = parseObj(CreateProjectSchema, { name: 'P' });
      expect('isArchived' in parsed).toBe(false);
    });
  });

  describe('UpdateProjectSchema', () => {
    it('accepts name and description independently', () => {
      expect(parseObj(UpdateProjectSchema, { name: 'New' })).toEqual({ name: 'New' });
      expect(parseObj(UpdateProjectSchema, { description: 'Desc' })).toEqual({
        description: 'Desc',
      });
    });

    it('rejects isArchived in the update payload (archive is a separate action)', () => {
      // Security/design: archive/unarchive is POST /archive, not PATCH.
      // The update schema deliberately excludes isArchived.
      expect(() => parseObj(UpdateProjectSchema, { isArchived: true })).toThrow();
    });

    it('an empty update is rejected (non-empty refine intact)', () => {
      expect(() => parseObj(UpdateProjectSchema, {})).toThrow();
    });

    it('rejects a blank name on update', () => {
      expect(() => parseObj(UpdateProjectSchema, { name: '   ' })).toThrow();
    });
  });

  describe('MoveTaskSchema', () => {
    it('accepts a status-only move', () => {
      expect(parseObj(MoveTaskSchema, { status: 'in_progress' })).toEqual({
        status: 'in_progress',
      });
    });

    it('rejects a project in the move payload (status-only by design)', () => {
      // Security: cross-project moves are forbidden via the move endpoint.
      // Changing projects is PATCH with projectId, not POST /move.
      expect(() =>
        parseObj(MoveTaskSchema, { status: 'done', projectId: 'some-project-id' }),
      ).toThrow();
    });

    it('rejects an empty move (nothing to do)', () => {
      expect(() => parseObj(MoveTaskSchema, {})).toThrow();
    });

    it('rejects an invalid status', () => {
      expect(() => parseObj(MoveTaskSchema, { status: 'nope' })).toThrow();
    });
  });
});
