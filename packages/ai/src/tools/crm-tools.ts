/**
 * The Phase 9 read-only tool set — contract §6.3 (binding).
 *
 * Each tool wraps exactly one EXISTING authorized service; no tool touches
 * the database itself, and no tool adds authorization of its own — the
 * registry pre-check gates on the declared permission and the service
 * enforces for real (RLS + scope + assertTargetAffected).
 *
 * Results are projected through the §7.2 context-recipe field allowlists
 * before they can reach the model: a DTO field outside the allowlist
 * (emails, phones, addresses, owner ids, audit columns) is dropped here,
 * and the dispatcher's output-schema validation fails the call if a
 * projection ever lets one through.
 *
 * Field-name mappings from recipe language to the actual DTOs:
 *  - company `city` / `state` are the DTO's `addressCity` / `addressState`.
 *  - activity `body` is the DTO's `notes` column (§7.2 recipe naming).
 *  - project: the §7.2 recipe names `status` / `startDate` / `endDate`,
 *    which do not exist on the Project DTO; the projection carries the
 *    DTO's real lifecycle field, `isArchived`, instead.
 * The record's own `id` is included in single-record results: the model
 * supplied it as the argument, so it conceals nothing, and the orchestrator
 * needs it for §5.3 source attribution.
 */
import { z } from 'zod';
import type { Authorization } from '@/lib/authz/require-permission';
import { getCompany } from '@/lib/crm/companies';
import { getContact } from '@/lib/crm/contacts';
import { getDeal } from '@/lib/crm/deals';
import { listActivities } from '@/lib/crm/activities';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  DEAL_STAGES,
  type Activity,
  type Company,
  type Contact,
  type Deal,
  type Page,
} from '@/lib/crm/schema';
import { getProject } from '@/lib/work/projects';
import { getTask } from '@/lib/work/tasks';
import { TaskPrioritySchema, TaskStatusSchema, type Project, type Task } from '@/lib/work/schema';
import {
  createToolRegistry,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_AUDIT_COUNT_ONLY,
  truncateField,
  type AiTool,
  type ToolRegistry,
} from './registry';

/** §6.3: the activity-history tool always reads at most 20 activities. */
export const ACTIVITY_HISTORY_LIMIT = 20;

/**
 * The services the tools wrap. Injected so tests can substitute fakes and
 * assert call/no-call behavior without a database; production uses the real
 * services below.
 */
export interface CrmToolServices {
  getCompany(auth: Authorization, id: string): Promise<Company>;
  getContact(auth: Authorization, id: string): Promise<Contact>;
  getDeal(auth: Authorization, id: string): Promise<Deal>;
  listActivities(auth: Authorization, input: unknown): Promise<Page<Activity>>;
  getProject(auth: Authorization, id: string): Promise<Project>;
  getTask(auth: Authorization, id: string): Promise<Task>;
}

const defaultServices: CrmToolServices = {
  getCompany,
  getContact,
  getDeal,
  listActivities,
  getProject,
  getTask,
};

const uuid = z.string().uuid();

const idInput = z.strictObject({ id: uuid });

const trunc = (value: string): string => truncateField(value) as string;

// ── Projections (§7.2 allowlists) ────────────────────────────────────────────

function projectCompany(company: Company) {
  return {
    id: company.id,
    name: trunc(company.name),
    domain: truncateField(company.domain),
    industry: truncateField(company.industry),
    size: truncateField(company.size),
    city: truncateField(company.addressCity),
    state: truncateField(company.addressState),
    countryCode: company.countryCode,
    createdAt: company.createdAt,
  };
}

function projectContact(contact: Contact) {
  return {
    id: contact.id,
    firstName: trunc(contact.firstName),
    lastName: trunc(contact.lastName),
    title: truncateField(contact.title),
    companyName: truncateField(contact.companyName),
  };
}

function projectDeal(deal: Deal) {
  return {
    id: deal.id,
    title: trunc(deal.title),
    value: deal.value,
    currency: deal.currency,
    stage: deal.stage,
    expectedCloseDate: deal.expectedCloseDate,
    companyId: deal.companyId,
    contactId: deal.contactId,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
  };
}

function projectActivity(activity: Activity) {
  return {
    type: activity.type,
    subject: trunc(activity.subject),
    body: truncateField(activity.notes),
    occurredAt: activity.occurredAt,
    dueAt: activity.dueAt,
  };
}

function projectProject(project: Project) {
  return {
    id: project.id,
    name: trunc(project.name),
    description: truncateField(project.description),
    isArchived: project.isArchived,
  };
}

function projectTask(task: Task) {
  return {
    id: task.id,
    title: trunc(task.title),
    description: truncateField(task.description),
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    projectId: task.projectId,
  };
}

// ── Output schemas (mirror the projections exactly; strict) ─────────────────

const companyOutput = z.strictObject({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  countryCode: z.string().nullable(),
  createdAt: z.string(),
});

const contactOutput = z.strictObject({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  companyName: z.string().nullable(),
});

const dealOutput = z.strictObject({
  id: z.string(),
  title: z.string(),
  value: z.string().nullable(),
  currency: z.string(),
  stage: z.enum(DEAL_STAGES),
  expectedCloseDate: z.string().nullable(),
  companyId: z.string().nullable(),
  contactId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const activityHistoryOutput = z.strictObject({
  entityType: z.enum(ACTIVITY_ENTITY_TYPES),
  entityId: z.string(),
  total: z.number(),
  activities: z.array(
    z.strictObject({
      type: z.enum(ACTIVITY_TYPES),
      subject: z.string(),
      body: z.string().nullable(),
      occurredAt: z.string().nullable(),
      dueAt: z.string().nullable(),
    }),
  ),
});

const projectOutput = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isArchived: z.boolean(),
});

const taskOutput = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  dueDate: z.string().nullable(),
  projectId: z.string().nullable(),
});

// ── The six tools (§6.3) ─────────────────────────────────────────────────────

export function createCrmTools(services: CrmToolServices = defaultServices): readonly AiTool[] {
  return Object.freeze([
    {
      id: 'get_company',
      description:
        'Retrieve one company the caller is authorized to view, by id. Returns the company name, domain, industry, size, city, state, country and creation date.',
      inputSchema: idInput,
      outputSchema: companyOutput,
      requiredPermission: 'companies.view',
      classification: 'read',
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      audit: TOOL_AUDIT_COUNT_ONLY,
      execute: async (auth, args) => {
        const { id } = args as z.infer<typeof idInput>;
        return projectCompany(await services.getCompany(auth, id));
      },
    },
    {
      id: 'get_contact',
      description:
        'Retrieve one contact the caller is authorized to view, by id. Returns the contact name, job title and company name.',
      inputSchema: idInput,
      outputSchema: contactOutput,
      requiredPermission: 'contacts.view',
      classification: 'read',
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      audit: TOOL_AUDIT_COUNT_ONLY,
      execute: async (auth, args) => {
        const { id } = args as z.infer<typeof idInput>;
        return projectContact(await services.getContact(auth, id));
      },
    },
    {
      id: 'get_deal',
      description:
        'Retrieve one deal the caller is authorized to view, by id. Returns the deal title, value, currency, stage, expected close date and its linked company/contact ids.',
      inputSchema: idInput,
      outputSchema: dealOutput,
      requiredPermission: 'deals.view',
      classification: 'read',
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      audit: TOOL_AUDIT_COUNT_ONLY,
      execute: async (auth, args) => {
        const { id } = args as z.infer<typeof idInput>;
        return projectDeal(await services.getDeal(auth, id));
      },
    },
    {
      id: 'get_activity_history',
      description:
        'Retrieve the most recent activity history (up to 20 entries) for one company, contact or deal the caller is authorized to view. Returns each activity type, subject, notes and dates.',
      inputSchema: z.strictObject({
        entityType: z.enum(ACTIVITY_ENTITY_TYPES),
        entityId: uuid,
      }),
      outputSchema: activityHistoryOutput,
      requiredPermission: 'activities.view',
      classification: 'read',
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      audit: TOOL_AUDIT_COUNT_ONLY,
      execute: async (auth, args) => {
        const { entityType, entityId } = args as {
          entityType: (typeof ACTIVITY_ENTITY_TYPES)[number];
          entityId: string;
        };
        const page = await services.listActivities(auth, {
          entityType,
          entityId,
          limit: ACTIVITY_HISTORY_LIMIT,
        });
        return {
          entityType,
          entityId,
          total: page.total,
          activities: page.rows.map(projectActivity),
        };
      },
    },
    {
      id: 'get_project',
      description:
        'Retrieve one work project the caller is authorized to view, by id. Returns the project name, description and archived state.',
      inputSchema: idInput,
      outputSchema: projectOutput,
      requiredPermission: 'projects.view',
      classification: 'read',
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      audit: TOOL_AUDIT_COUNT_ONLY,
      execute: async (auth, args) => {
        const { id } = args as z.infer<typeof idInput>;
        return projectProject(await services.getProject(auth, id));
      },
    },
    {
      id: 'get_task',
      description:
        'Retrieve one work task the caller is authorized to view, by id. Returns the task title, description, status, priority, due date and project id.',
      inputSchema: idInput,
      outputSchema: taskOutput,
      requiredPermission: 'tasks.view',
      classification: 'read',
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      audit: TOOL_AUDIT_COUNT_ONLY,
      execute: async (auth, args) => {
        const { id } = args as z.infer<typeof idInput>;
        return projectTask(await services.getTask(auth, id));
      },
    },
  ]);
}

/** The Phase 9 tool set, wrapping the real services. */
export const crmTools: readonly AiTool[] = createCrmTools();

/** The composed registry the orchestrator enumerates and dispatches through. */
export const toolRegistry: ToolRegistry = createToolRegistry(crmTools);
