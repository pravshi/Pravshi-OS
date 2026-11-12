/**
 * Pravshi OS — CRM Tasks Contract (Layer 2).
 *
 * Owned by packages/contracts; implemented by packages/crm-core.
 * Enforces XOR target binding (exactly one of leadId or contactId).
 */
import { z } from 'zod';
import { UuidSchema } from '../base';

export const CRM_TASK_TYPES = [
  'FOLLOW_UP',
  'SITE_VISIT',
  'DOCUMENT_COLLECTION',
  'CALL_BACK',
  'GENERAL',
] as const;
export const CrmTaskTypeEnum = z.enum(CRM_TASK_TYPES);
export type CrmTaskType = z.infer<typeof CrmTaskTypeEnum>;

export const CRM_TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const CrmTaskPriorityEnum = z.enum(CRM_TASK_PRIORITIES);
export type CrmTaskPriority = z.infer<typeof CrmTaskPriorityEnum>;

export const CRM_TASK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'OVERDUE',
] as const;
export const CrmTaskStatusEnum = z.enum(CRM_TASK_STATUSES);
export type CrmTaskStatus = z.infer<typeof CrmTaskStatusEnum>;

export const CrmTaskSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    leadId: UuidSchema.nullable().optional(),
    contactId: UuidSchema.nullable().optional(),
    title: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    taskType: CrmTaskTypeEnum,
    priority: CrmTaskPriorityEnum.default('MEDIUM'),
    status: CrmTaskStatusEnum.default('PENDING'),
    dueAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable().optional(),
    reminderSentAt: z.string().datetime().nullable().optional(),
    assigneePersonId: UuidSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine(
    (data) => {
      const hasLead = Boolean(data.leadId);
      const hasContact = Boolean(data.contactId);
      return (hasLead && !hasContact) || (!hasLead && hasContact);
    },
    {
      message: 'Task must reference exactly one of leadId or contactId',
      path: ['leadId'],
    },
  );
export type CrmTask = z.infer<typeof CrmTaskSchema>;

export const CreateCrmTaskInputSchema = z
  .object({
    leadId: UuidSchema.optional(),
    contactId: UuidSchema.optional(),
    title: z.string().min(1).max(255),
    description: z.string().optional(),
    taskType: CrmTaskTypeEnum,
    priority: CrmTaskPriorityEnum.default('MEDIUM'),
    dueAt: z.string().datetime(),
    assigneePersonId: UuidSchema,
  })
  .refine(
    (data) => {
      const hasLead = Boolean(data.leadId);
      const hasContact = Boolean(data.contactId);
      return (hasLead && !hasContact) || (!hasLead && hasContact);
    },
    {
      message: 'Task must reference exactly one of leadId or contactId',
      path: ['leadId'],
    },
  );
export type CreateCrmTaskInput = z.infer<typeof CreateCrmTaskInputSchema>;

export const UpdateCrmTaskInputSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  priority: CrmTaskPriorityEnum.optional(),
  status: CrmTaskStatusEnum.optional(),
  dueAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  assigneePersonId: UuidSchema.optional(),
});
export type UpdateCrmTaskInput = z.infer<typeof UpdateCrmTaskInputSchema>;
