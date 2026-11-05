import {
  bigint,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text type (PostgreSQL citext extension).
 */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * public.crm_leads — Phase 1 Core CRM Lead table.
 */
export const crmLeads = pgTable(
  'crm_leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    fullName: text('full_name').notNull(),
    primaryPhone: text('primary_phone').notNull(),
    email: citext('email'),
    source: text('source').notNull(),
    sourceSubcategory: text('source_subcategory'),
    campaignId: text('campaign_id'),
    ownerPersonId: uuid('owner_person_id'),
    teamId: uuid('team_id'),
    stage: text('stage').notNull().default('new'),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }).notNull(),
    firstContactedAt: timestamp('first_contacted_at', { withTimezone: true }),
    firstSuccessfulContactAt: timestamp('first_successful_contact_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    importBatchId: uuid('import_batch_id'),
    importRowNumber: integer('import_row_number'),
    convertedContactId: uuid('converted_contact_id'),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    mergedIntoLeadId: uuid('merged_into_lead_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [unique('crm_leads_id_org_unique').on(table.id, table.orgId)],
);

/**
 * public.crm_lead_assignment_history — Append-only assignment ledger.
 */
export const crmLeadAssignmentHistory = pgTable(
  'crm_lead_assignment_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    fromPersonId: uuid('from_person_id'),
    toPersonId: uuid('to_person_id'),
    reassignedByPersonId: uuid('reassigned_by_person_id'),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('crm_lead_assign_hist_id_org_unique').on(table.id, table.orgId)],
);

/**
 * public.crm_assignment_cursors — Deterministic round-robin cursor state per team.
 */
export const crmAssignmentCursors = pgTable(
  'crm_assignment_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    teamId: uuid('team_id').notNull(),
    lastAssignedPersonId: uuid('last_assigned_person_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('crm_assignment_cursors_id_org_unique').on(table.id, table.orgId),
    unique('crm_assignment_cursors_team_unique').on(table.orgId, table.teamId),
  ],
);

/**
 * public.crm_lead_tasks — Follow-up tasks with polymorphic XOR target constraint.
 */
export const crmLeadTasks = pgTable(
  'crm_lead_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    leadId: uuid('lead_id'),
    contactId: uuid('contact_id'),
    title: text('title').notNull(),
    description: text('description'),
    taskType: text('task_type').notNull(),
    priority: text('priority').notNull().default('MEDIUM'),
    status: text('status').notNull().default('PENDING'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    assigneePersonId: uuid('assignee_person_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [unique('crm_lead_tasks_id_org_unique').on(table.id, table.orgId)],
);

/**
 * public.crm_dedup_candidates — Candidate duplicate entity pairs.
 */
export const crmDedupCandidates = pgTable(
  'crm_dedup_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    entityType: text('entity_type').notNull(),
    primaryEntityId: uuid('primary_entity_id').notNull(),
    duplicateEntityId: uuid('duplicate_entity_id').notNull(),
    confidenceScore: numeric('confidence_score', { precision: 3, scale: 2 }).notNull(),
    matchReasons: jsonb('match_reasons').notNull().default([]),
    status: text('status').notNull().default('PENDING'),
    reviewedByPersonId: uuid('reviewed_by_person_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('crm_dedup_candidates_id_org_unique').on(table.id, table.orgId),
    unique('crm_dedup_candidates_pair_unique').on(
      table.orgId,
      table.entityType,
      table.primaryEntityId,
      table.duplicateEntityId,
    ),
  ],
);

/**
 * public.crm_lead_attribution_corrections — Governed two-person attribution correction requests.
 */
export const crmLeadAttributionCorrections = pgTable(
  'crm_lead_attribution_corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    fieldName: text('field_name').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('PENDING'),
    requestedByPersonId: uuid('requested_by_person_id').notNull(),
    approvedByPersonId: uuid('approved_by_person_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => [unique('crm_lead_attr_corr_id_org_unique').on(table.id, table.orgId)],
);

/**
 * public.re_lead_preferences — Real Estate property vertical preference extension.
 */
export const reLeadPreferences = pgTable(
  're_lead_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    propertyTypes: text('property_types').array().notNull().default([]),
    budgetMinPaise: bigint('budget_min_paise', { mode: 'bigint' }),
    budgetMaxPaise: bigint('budget_max_paise', { mode: 'bigint' }),
    preferredLocalities: text('preferred_localities').array().notNull().default([]),
    possessionTimeline: text('possession_timeline'),
    bhkPreferences: text('bhk_preferences').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('re_lead_pref_id_org_unique').on(table.id, table.orgId),
    unique('re_lead_pref_lead_unique').on(table.orgId, table.leadId),
  ],
);
