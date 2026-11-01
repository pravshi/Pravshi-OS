/**
 * Per-capability context recipes (Phase 9, Workstream D).
 *
 * Contract §7.1 (prime rule) and §7.2 (recipes): the builder fetches ONLY
 * through the existing authorized services named in the architecture audit
 * §2.5 — never SQL against CRM/work tables, never an org id from the client,
 * never a widening of access. If the caller cannot see a record in the UI,
 * the identical call here returns the service's NOT_FOUND.
 *
 * Error posture:
 * - The recipe's TARGET record: the service's error propagates untouched
 *   (NOT_FOUND / FORBIDDEN) — no partial context is ever substituted.
 * - RELATED records (a deal's company, a task's project, an activity's
 *   parent): a NOT_FOUND means "not visible to this caller" and the block is
 *   simply omitted — the target was authorized, and omitting leaks nothing.
 *   Any other error propagates.
 *
 * Every projection applies a hard field allowlist (CONTEXT_ALLOWLISTS):
 * DTOs are projected, never passed raw, so emails, phones, addresses,
 * probability, owner ids and audit columns never reach the model — data
 * minimization on top of authorization.
 *
 * Repo naming adaptations (DTO reality over contract shorthand):
 * - the activity "body" of §7.2 is the Activity DTO's `notes` field;
 * - company city/state are the DTO's `addressCity` / `addressState`;
 * - the Project DTO has no status/startDate/endDate — the recipe projects
 *   what exists (name, description, isArchived, createdAt, updatedAt);
 * - listProjectTasks takes (auth, projectId, input) — projectId is a
 *   separate argument, verified in src/lib/work/tasks.ts.
 */
import { AuthorizationError } from '@/lib/authz/errors';
import type { Authorization } from '@/lib/authz/require-permission';
import { getActivity, listActivities } from '@/lib/crm/activities';
import { getCompany } from '@/lib/crm/companies';
import { getContact, listContacts } from '@/lib/crm/contacts';
import { getDeal, listDeals } from '@/lib/crm/deals';
import type { Activity, Company, Contact, Deal } from '@/lib/crm/schema';
import { getProject } from '@/lib/work/projects';
import { getTask, listProjectTasks } from '@/lib/work/tasks';
import type { Project, Task } from '@/lib/work/schema';
import type {
  AiCapabilityId,
  AiContextEntityType,
  AiContextSource,
  AiContextTarget,
  ContextSegment,
  ContextSegmentKind,
  ProjectedRecord,
  RecipeResult,
} from './types';

/** Fetch bounds (contract §7.2/§7.3): at most 20 activities or list items
 * per recipe; the project recipe fetches 50 tasks and shows the first 20. */
export const ACTIVITY_FETCH_LIMIT = 20;
export const LIST_FETCH_LIMIT = 20;
export const PROJECT_TASK_FETCH_LIMIT = 50;
export const PROJECT_TASK_SHOWN_LIMIT = 20;

/** The DTO properties each projection may read — the reviewable allowlist.
 * Anything not listed here (email, phone, website, address lines, postal
 * code, probability, pipeline ids, owner/assignee ids, audit columns) never
 * reaches the model. Also consumed by Workstream E: tool results pass
 * through these same projections (contract §6.3). */
export const CONTEXT_ALLOWLISTS = {
  deal: [
    'title',
    'value',
    'currency',
    'stage',
    'expectedCloseDate',
    'companyId',
    'contactId',
    'createdAt',
    'updatedAt',
  ],
  dealBrief: ['title', 'value', 'currency', 'stage'],
  company: [
    'name',
    'domain',
    'industry',
    'size',
    'addressCity',
    'addressState',
    'countryCode',
    'createdAt',
  ],
  companyBrief: ['name', 'industry', 'size'],
  contact: ['firstName', 'lastName', 'title', 'companyName'],
  contactBrief: ['firstName', 'lastName', 'title'],
  activity: ['type', 'subject', 'notes', 'occurredAt', 'dueAt'],
  activityFull: ['type', 'subject', 'notes', 'occurredAt', 'dueAt', 'entityType', 'entityId'],
  project: ['name', 'description', 'isArchived', 'createdAt', 'updatedAt'],
  task: ['title', 'description', 'status', 'priority', 'dueDate', 'projectId'],
  taskBrief: ['title', 'status', 'priority', 'dueDate'],
} as const;

/** Target entity types each capability accepts (contract §6.1/§7.2).
 * general_assistance never fetches its target — record data arrives only via
 * tools — so every type is "accepted" and ignored by its recipe. */
export const CAPABILITY_TARGET_TYPES: Readonly<
  Record<AiCapabilityId, readonly AiContextEntityType[]>
> = {
  lead_summary: ['deal'],
  deal_summary: ['deal'],
  contact_summary: ['contact'],
  company_summary: ['company'],
  activity_summary: ['activity', 'company', 'contact', 'deal'],
  project_summary: ['project'],
  task_summary: ['task'],
  general_assistance: ['company', 'contact', 'deal', 'activity', 'project', 'task'],
};

// ── Projection helpers ──────────────────────────────────────────────────────

type RawValue = string | number | boolean | null | undefined;

/** Build ordered field lines, dropping absent values. Null, undefined and
 * empty-after-trim strings are omitted: an absent line is how the model
 * learns a field has no recorded value (its `missingInformation` signal). */
function fieldLines(
  entries: readonly (readonly [string, RawValue])[],
): (readonly [string, string])[] {
  const out: [string, string][] = [];
  for (const [key, raw] of entries) {
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.trim() : String(raw);
    if (value.length === 0) continue;
    out.push([key, value]);
  }
  return out;
}

export function contactLabel(contact: Contact): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

// ── Projections (DTO → allowlisted record) ──────────────────────────────────

export function projectDeal(deal: Deal): ProjectedRecord {
  return {
    entityType: 'deal',
    entityId: deal.id,
    label: deal.title,
    fields: fieldLines([
      ['title', deal.title],
      ['value', deal.value],
      ['currency', deal.currency],
      ['stage', deal.stage],
      ['expected_close_date', deal.expectedCloseDate],
      ['company_id', deal.companyId],
      ['contact_id', deal.contactId],
      ['created_at', deal.createdAt],
      ['updated_at', deal.updatedAt],
    ]),
  };
}

export function projectDealBrief(deal: Deal): ProjectedRecord {
  return {
    entityType: 'deal',
    entityId: deal.id,
    label: deal.title,
    fields: fieldLines([
      ['title', deal.title],
      ['value', deal.value],
      ['currency', deal.currency],
      ['stage', deal.stage],
    ]),
  };
}

export function projectCompany(company: Company): ProjectedRecord {
  return {
    entityType: 'company',
    entityId: company.id,
    label: company.name,
    fields: fieldLines([
      ['name', company.name],
      ['domain', company.domain],
      ['industry', company.industry],
      ['size', company.size],
      ['city', company.addressCity],
      ['state', company.addressState],
      ['country_code', company.countryCode],
      ['created_at', company.createdAt],
    ]),
  };
}

export function projectCompanyBrief(company: Company): ProjectedRecord {
  return {
    entityType: 'company',
    entityId: company.id,
    label: company.name,
    fields: fieldLines([
      ['name', company.name],
      ['industry', company.industry],
      ['size', company.size],
    ]),
  };
}

export function projectContact(contact: Contact): ProjectedRecord {
  return {
    entityType: 'contact',
    entityId: contact.id,
    label: contactLabel(contact),
    fields: fieldLines([
      ['first_name', contact.firstName],
      ['last_name', contact.lastName],
      ['title', contact.title],
      ['company_name', contact.companyName],
    ]),
  };
}

export function projectContactBrief(contact: Contact): ProjectedRecord {
  return {
    entityType: 'contact',
    entityId: contact.id,
    label: contactLabel(contact),
    fields: fieldLines([
      ['first_name', contact.firstName],
      ['last_name', contact.lastName],
      ['title', contact.title],
    ]),
  };
}

/** The §7.2 activity projection — `notes` is the activity body. */
export function projectActivity(activity: Activity): ProjectedRecord {
  return {
    entityType: 'activity',
    entityId: activity.id,
    label: activity.subject,
    fields: fieldLines([
      ['type', activity.type],
      ['subject', activity.subject],
      ['body', activity.notes],
      ['occurred_at', activity.occurredAt],
      ['due_at', activity.dueAt],
    ]),
  };
}

/** The activity recipe's own projection adds the parent linkage (§7.2). */
export function projectActivityFull(activity: Activity): ProjectedRecord {
  const base = projectActivity(activity);
  return {
    ...base,
    fields: [
      ...base.fields,
      ...fieldLines([
        ['entity_type', activity.entityType],
        ['entity_id', activity.entityId],
      ]),
    ],
  };
}

export function projectProject(project: Project): ProjectedRecord {
  return {
    entityType: 'project',
    entityId: project.id,
    label: project.name,
    fields: fieldLines([
      ['name', project.name],
      ['description', project.description],
      ['archived', project.isArchived],
      ['created_at', project.createdAt],
      ['updated_at', project.updatedAt],
    ]),
  };
}

export function projectTask(task: Task): ProjectedRecord {
  return {
    entityType: 'task',
    entityId: task.id,
    label: task.title,
    fields: fieldLines([
      ['title', task.title],
      ['description', task.description],
      ['status', task.status],
      ['priority', task.priority],
      ['due_date', task.dueDate],
      ['project_id', task.projectId],
    ]),
  };
}

export function projectTaskBrief(task: Task): ProjectedRecord {
  return {
    entityType: 'task',
    entityId: task.id,
    label: task.title,
    fields: fieldLines([
      ['title', task.title],
      ['status', task.status],
      ['priority', task.priority],
      ['due_date', task.dueDate],
    ]),
  };
}

/** A label-only block: identifies a related record without projecting any of
 * its fields (the §7.2 "parent label" / "project label" recipes). */
function labelOnlyRecord(
  entityType: AiContextEntityType,
  entityId: string,
  label: string,
): ProjectedRecord {
  return { entityType, entityId, label, fields: [] };
}

// ── Segment assembly helpers ────────────────────────────────────────────────

function segment(kind: ContextSegmentKind, record: ProjectedRecord): ContextSegment {
  const source: AiContextSource | undefined =
    record.entityId !== undefined && isRecordEntityType(record.entityType)
      ? { entityType: record.entityType, entityId: record.entityId, label: record.label }
      : undefined;
  return source ? { ...record, kind, source } : { ...record, kind };
}

function isRecordEntityType(value: string): value is AiContextEntityType {
  return (
    value === 'company' ||
    value === 'contact' ||
    value === 'deal' ||
    value === 'activity' ||
    value === 'project' ||
    value === 'task'
  );
}

/**
 * Fetch a RELATED record, tolerating invisibility: a NOT_FOUND from the
 * service means the caller cannot see this related record, so its block is
 * omitted (nothing is substituted, nothing leaks). Every other error —
 * including FORBIDDEN — propagates exactly as the service raised it.
 */
async function optionalRelated<T>(fetch: () => Promise<T>): Promise<T | null> {
  try {
    return await fetch();
  } catch (err) {
    if (err instanceof AuthorizationError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

type CrmEntityType = 'company' | 'contact' | 'deal';

/** The newest-first activity list for a CRM parent (the service orders by
 * occurred_at desc), projected and segmented. Oldest entries sit at the end
 * of the returned array — the builder's drop-oldest-first cap relies on it. */
async function activitySegments(
  auth: Authorization,
  entityType: CrmEntityType,
  entityId: string,
): Promise<ContextSegment[]> {
  const page = await optionalRelated(() =>
    listActivities(auth, { entityType, entityId, limit: ACTIVITY_FETCH_LIMIT, offset: 0 }),
  );
  if (!page) return [];
  return page.rows.map((activity) => segment('activity', projectActivity(activity)));
}

// ── Recipes ─────────────────────────────────────────────────────────────────

/** deal recipe — deal_summary and lead_summary (a lead is a deal; §6.1). */
export async function buildDealContext(auth: Authorization, dealId: string): Promise<RecipeResult> {
  const deal = await getDeal(auth, dealId);
  const segments: ContextSegment[] = [segment('primary', projectDeal(deal))];

  const companyId = deal.companyId;
  if (companyId) {
    const company = await optionalRelated(() => getCompany(auth, companyId));
    if (company) segments.push(segment('related', projectCompanyBrief(company)));
  }
  const contactId = deal.contactId;
  if (contactId) {
    const contact = await optionalRelated(() => getContact(auth, contactId));
    if (contact) segments.push(segment('related', projectContactBrief(contact)));
  }
  segments.push(...(await activitySegments(auth, 'deal', deal.id)));
  return { segments };
}

/** company recipe — company_summary. */
export async function buildCompanyContext(
  auth: Authorization,
  companyId: string,
): Promise<RecipeResult> {
  const company = await getCompany(auth, companyId);
  const segments: ContextSegment[] = [segment('primary', projectCompany(company))];

  const contacts = await optionalRelated(() =>
    listContacts(auth, { companyId: company.id, limit: LIST_FETCH_LIMIT, offset: 0 }),
  );
  if (contacts) {
    for (const contact of contacts.rows) {
      segments.push(segment('list', projectContactBrief(contact)));
    }
  }
  const deals = await optionalRelated(() =>
    listDeals(auth, { companyId: company.id, limit: LIST_FETCH_LIMIT, offset: 0 }),
  );
  if (deals) {
    for (const deal of deals.rows) {
      segments.push(segment('list', projectDealBrief(deal)));
    }
  }
  segments.push(...(await activitySegments(auth, 'company', company.id)));
  return { segments };
}

/** contact recipe — contact_summary. */
export async function buildContactContext(
  auth: Authorization,
  contactId: string,
): Promise<RecipeResult> {
  const contact = await getContact(auth, contactId);
  const segments: ContextSegment[] = [segment('primary', projectContact(contact))];

  const companyId = contact.companyId;
  if (companyId) {
    const company = await optionalRelated(() => getCompany(auth, companyId));
    if (company) segments.push(segment('related', projectCompanyBrief(company)));
  }
  segments.push(...(await activitySegments(auth, 'contact', contact.id)));
  return { segments };
}

/** activity recipe — activity_summary, in both of its §6.1 shapes: the
 * target is an activity itself, or a company/contact/deal whose activity
 * history is summarized. */
export async function buildActivityContext(
  auth: Authorization,
  target: AiContextTarget,
): Promise<RecipeResult> {
  if (target.entityType === 'activity') {
    const activity = await getActivity(auth, target.entityId);
    const segments: ContextSegment[] = [segment('primary', projectActivityFull(activity))];
    const parent = await activityParentLabel(auth, activity);
    if (parent) segments.push(parent);
    return { segments };
  }

  // Parent-target shape: the parent is the authorized target (errors
  // propagate), its brief block orients the history that follows.
  const entityType = target.entityType as CrmEntityType;
  let parentRecord: ProjectedRecord;
  if (entityType === 'company') {
    parentRecord = projectCompanyBrief(await getCompany(auth, target.entityId));
  } else if (entityType === 'contact') {
    parentRecord = projectContactBrief(await getContact(auth, target.entityId));
  } else {
    parentRecord = projectDealBrief(await getDeal(auth, target.entityId));
  }
  const segments: ContextSegment[] = [segment('primary', parentRecord)];
  segments.push(...(await activitySegments(auth, entityType, target.entityId)));
  return { segments };
}

/** The parent record's one-line label for the activity recipe — label only,
 * and only when the caller can actually see the parent. */
async function activityParentLabel(
  auth: Authorization,
  activity: Activity,
): Promise<ContextSegment | null> {
  if (activity.entityType === 'company') {
    const company = await optionalRelated(() => getCompany(auth, activity.entityId));
    return company
      ? segment('related', labelOnlyRecord('company', company.id, company.name))
      : null;
  }
  if (activity.entityType === 'contact') {
    const contact = await optionalRelated(() => getContact(auth, activity.entityId));
    return contact
      ? segment('related', labelOnlyRecord('contact', contact.id, contactLabel(contact)))
      : null;
  }
  const deal = await optionalRelated(() => getDeal(auth, activity.entityId));
  return deal ? segment('related', labelOnlyRecord('deal', deal.id, deal.title)) : null;
}

/** project recipe — project_summary: the project, its true task total with
 * by-status counts over the fetched page, and the first 20 tasks. */
export async function buildProjectContext(
  auth: Authorization,
  projectId: string,
): Promise<RecipeResult> {
  const project = await getProject(auth, projectId);
  const page = await listProjectTasks(auth, project.id, {
    limit: PROJECT_TASK_FETCH_LIMIT,
    offset: 0,
  });
  const shown = page.rows.slice(0, PROJECT_TASK_SHOWN_LIMIT);

  const counts: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
  for (const task of page.rows) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  const countsRecord: ProjectedRecord = {
    entityType: 'project_task_counts',
    entityId: project.id,
    label: `${project.name} — task counts`,
    fields: fieldLines([
      ['total_tasks', page.total],
      ['tasks_fetched', page.rows.length],
      ['tasks_shown', shown.length],
      ['status_todo', counts['todo']],
      ['status_in_progress', counts['in_progress']],
      ['status_done', counts['done']],
    ]),
  };

  const segments: ContextSegment[] = [
    segment('primary', projectProject(project)),
    { ...countsRecord, kind: 'meta' },
    ...shown.map((task) => segment('list', projectTaskBrief(task))),
  ];
  return { segments };
}

/** task recipe — task_summary. */
export async function buildTaskContext(auth: Authorization, taskId: string): Promise<RecipeResult> {
  const task = await getTask(auth, taskId);
  const segments: ContextSegment[] = [segment('primary', projectTask(task))];

  const projectId = task.projectId;
  if (projectId) {
    const project = await optionalRelated(() => getProject(auth, projectId));
    if (project) {
      segments.push(segment('related', labelOnlyRecord('project', project.id, project.name)));
    }
  }
  return { segments };
}

/**
 * general_assistance recipe (§7.2): no pre-fetched records — all record data
 * arrives only through the §6.3 tools. The context is orientation from the
 * authorized session itself: the caller's effective scope for the ai.use
 * grant. Display names (org / caller) are deliberately absent: no service in
 * the audit §2.5 data path exposes them, and this builder never queries
 * tables directly to invent a side channel (§7.1).
 */
export function buildGeneralContext(auth: Authorization): RecipeResult {
  const orientation: ContextSegment = {
    kind: 'orientation',
    entityType: 'session',
    label: 'Session orientation',
    fields: fieldLines([
      ['access_scope', auth.scope],
      ['records_pre_fetched', 'none — record data is available only through the authorized tools'],
    ]),
  };
  return { segments: [orientation] };
}
