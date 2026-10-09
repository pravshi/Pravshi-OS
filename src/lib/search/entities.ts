/**
 * Searchable entity registry — Phase 8 Search & Notifications (Workstream B).
 *
 * One config per searchable entity. All SQL fragments here are TRUSTED
 * constants (migration-contract table/column names); they are interpolated as
 * identifiers/expressions, never built from user input. User input travels
 * only as bound parameters (see query.ts).
 *
 * Column contract (verified against the migrations named):
 * - companies   (0033): name, domain, industry, owner_person_id
 * - contacts    (0033): first_name, last_name, email, title, owner_person_id
 * - deals       (0033): title, stage, value, currency, owner_person_id
 * - activities  (0034): subject, notes ("description" in the contract maps to
 *               the `notes` column), type, entity_type, entity_id, owner_person_id
 * - work_projects (0042): name, description, is_archived, deal_id
 * - work_tasks    (0042): title, description, status, priority, project_id,
 *               assignee_person_id
 * - workflows   (0044): name, description, status, trigger_type
 * - people      (0002/0017): full_legal_name, work_email. Per the 0017 rule the
 *               searchable columns and metadata MUST NOT include personal_email,
 *               phone, or date_of_birth.
 */
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from './types';

/**
 * The existing view permission that gates each searchable entity (§16.6).
 * NO new permission is introduced for search: a result is returned only when
 * the caller holds the entity's own view permission.
 */
export const ENTITY_VIEW_PERMISSIONS: Readonly<Record<SearchEntityType, string>> = Object.freeze({
  contact: 'contacts.view',
  company: 'companies.view',
  deal: 'deals.view',
  activity: 'activities.view',
  project: 'projects.view',
  task: 'tasks.view',
  workflow: 'workflows.view',
  person: 'people.view',
});

export interface SearchEntityConfig {
  entityType: SearchEntityType;
  /** Trusted table name (with schema). */
  table: string;
  /** Trusted SQL expressions referencing the row alias `e`. */
  titleExpr: string;
  subtitleExpr: string;
  /** Trusted SQL expression producing a JSON object (or the literal `null`). */
  metadataExpr: string;
  /** Trusted bare column names searched with ILIKE / trigram. */
  searchColumns: string[];
  /** Frontend deep-link prefix; the row id is appended. */
  urlPrefix: string;
  /** Optional entity-specific status filter: trusted column + strict allowlist. */
  statusColumn?: string;
  statusValues?: readonly string[];
  /** Optional owner filter column. Entities without one ignore `ownerId`. */
  ownerColumn?: string;
}

function jsonb(pairs: string): string {
  return `jsonb_build_object(${pairs})`;
}

const CONTACT: SearchEntityConfig = {
  entityType: 'contact',
  table: 'public.contacts',
  titleExpr: `btrim(e.first_name || ' ' || e.last_name)`,
  subtitleExpr: `e.email`,
  metadataExpr: jsonb(`'email', e.email, 'jobTitle', e.title`),
  searchColumns: ['first_name', 'last_name', 'email'],
  urlPrefix: '/crm/contacts',
  ownerColumn: 'owner_person_id',
};

const COMPANY: SearchEntityConfig = {
  entityType: 'company',
  table: 'public.companies',
  titleExpr: `e.name`,
  subtitleExpr: `e.domain`,
  metadataExpr: jsonb(`'domain', e.domain, 'industry', e.industry`),
  searchColumns: ['name', 'domain'],
  urlPrefix: '/crm/companies',
  ownerColumn: 'owner_person_id',
};

const DEAL: SearchEntityConfig = {
  entityType: 'deal',
  table: 'public.deals',
  titleExpr: `e.title`,
  subtitleExpr: `e.stage`,
  metadataExpr: jsonb(`'stage', e.stage, 'value', e.value, 'currency', e.currency`),
  searchColumns: ['title'],
  urlPrefix: '/crm/deals',
  statusColumn: 'stage',
  statusValues: ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'],
  ownerColumn: 'owner_person_id',
};

const ACTIVITY: SearchEntityConfig = {
  entityType: 'activity',
  table: 'public.activities',
  titleExpr: `e.subject`,
  subtitleExpr: `e.type`,
  metadataExpr: jsonb(`'type', e.type, 'entityType', e.entity_type, 'entityId', e.entity_id::text`),
  // Contract "description" maps to the `notes` column (migration 0034).
  searchColumns: ['subject', 'notes'],
  urlPrefix: '/crm/activities',
  statusColumn: 'type',
  statusValues: ['CALL', 'EMAIL', 'MEETING', 'NOTE'],
  ownerColumn: 'owner_person_id',
};

const PROJECT: SearchEntityConfig = {
  entityType: 'project',
  table: 'public.work_projects',
  titleExpr: `e.name`,
  subtitleExpr: `left(e.description, 120)`,
  metadataExpr: jsonb(`'isArchived', e.is_archived, 'dealId', e.deal_id::text`),
  searchColumns: ['name', 'description'],
  urlPrefix: '/work/projects',
};

const TASK: SearchEntityConfig = {
  entityType: 'task',
  table: 'public.work_tasks',
  titleExpr: `e.title`,
  subtitleExpr: `e.status`,
  metadataExpr: jsonb(
    `'status', e.status, 'priority', e.priority, 'projectId', e.project_id::text`,
  ),
  searchColumns: ['title', 'description'],
  urlPrefix: '/work/tasks',
  statusColumn: 'status',
  statusValues: ['todo', 'in_progress', 'done'],
  ownerColumn: 'assignee_person_id',
};

const WORKFLOW: SearchEntityConfig = {
  entityType: 'workflow',
  table: 'public.workflows',
  titleExpr: `e.name`,
  subtitleExpr: `e.status`,
  metadataExpr: jsonb(`'status', e.status, 'triggerType', e.trigger_type`),
  searchColumns: ['name', 'description'],
  urlPrefix: '/workflows',
  statusColumn: 'status',
  statusValues: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'],
};

const PERSON: SearchEntityConfig = {
  entityType: 'person',
  table: 'public.people',
  titleExpr: `e.full_legal_name`,
  subtitleExpr: `e.work_email`,
  // 0017 rule: people search metadata carries work_email ONLY.
  metadataExpr: jsonb(`'workEmail', e.work_email`),
  searchColumns: ['full_legal_name', 'work_email'],
  // No person detail page exists in the app; the users list is the surface.
  // Workstream D: if the viewer lacks `users.view`, fall back to /admin/users.
  urlPrefix: '/admin/users',
  ownerColumn: 'id',
};

const CONFIGS: Readonly<Record<SearchEntityType, SearchEntityConfig>> = Object.freeze({
  contact: CONTACT,
  company: COMPANY,
  deal: DEAL,
  project: PROJECT,
  task: TASK,
  activity: ACTIVITY,
  workflow: WORKFLOW,
  person: PERSON,
});

export function entityConfig(entityType: SearchEntityType): SearchEntityConfig {
  return CONFIGS[entityType];
}

/**
 * The strict allowlist of status values across a set of entities. Used to
 * validate the `status` filter: a value outside every visible entity's
 * allowlist is rejected as INVALID_REQUEST, never passed to SQL raw.
 */
export function allowedStatusValues(entityTypes: readonly SearchEntityType[]): ReadonlySet<string> {
  const values = new Set<string>();
  for (const entityType of entityTypes) {
    for (const value of CONFIGS[entityType].statusValues ?? []) values.add(value);
  }
  return values;
}

/** Asserts at module load that the registry covers exactly the 8 approved types. */
for (const entityType of SEARCH_ENTITY_TYPES) {
  if (!CONFIGS[entityType]) {
    throw new Error(`search entity registry is missing config for '${entityType}'`);
  }
}
