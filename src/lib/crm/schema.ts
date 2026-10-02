import { z } from 'zod';

/**
 * CRM Core input validation (Phase 2). Every untrusted value — server-action arguments
 * and REST bodies/query strings alike — is validated here, at the boundary, before a
 * service function touches the database.
 *
 * ── COLUMN CONTRACT WITH MIGRATION 0033 ─────────────────────────────────────────
 *
 * The services in this module address the tables with raw SQL, so a column-name drift
 * between this file and 0033 is a runtime error, not a type error. The columns per table:
 *
 *   companies: id, org_id, name, domain, industry, size, website, phone,
 *              address_line1, address_line2, city, state,
 *              postal_code, country_code, owner_person_id,
 *              created_at, updated_at, deleted_at
 *              (+ created_by/updated_by, stamped by trigger — never written here)
 *   contacts:  id, org_id, company_id, first_name, last_name, email, phone,
 *              title, department, owner_person_id,
 *              created_at, updated_at, deleted_at (+ created_by/updated_by)
 *   deals:     id, org_id, title, company_id, contact_id, value, currency, stage,
 *              probability, owner_person_id, expected_close_date, closed_at,
 *              created_at, updated_at, deleted_at (+ created_by/updated_by)
 *
 * Wire contract: the API speaks camelCase; SQL aliases translate (city AS "addressCity").
 * If 0033 names a column differently, update the SQL in companies.ts only.
 *
 * The permissions catalogue must carry companies/contacts/deals view/create/edit/delete
 * (module 'crm', seeded by migration 0033) before these endpoints can answer anything
 * other than 403 — requirePermission() fails closed on an unknown key.
 */

const uuid = z.string().uuid();
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

/** List query for contacts: pagination plus an optional owning-company filter
 * (U3 — detail pages fetch related records server-side instead of filtering a
 * capped list in the browser). */
export const ListContactsQuerySchema = ListQuerySchema.extend({
  companyId: uuid.optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuerySchema>;

// ── Companies ────────────────────────────────────────────────────────────────────

export const CreateCompanySchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  domain: nullableText(255),
  industry: nullableText(128),
  size: nullableText(64),
  website: nullableText(2048),
  phone: nullableText(64),
  addressLine1: nullableText(255),
  addressLine2: nullableText(255),
  addressCity: nullableText(128),
  addressState: nullableText(128),
  addressPostalCode: nullableText(32),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase())
    .nullable()
    .optional(),
});
export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;

/** Partial update: every field optional, at least one required. */
export const UpdateCompanySchema = CreateCompanySchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'at least one field is required',
);
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;

export type Company = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  website: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressPostalCode: string | null;
  countryCode: string | null;
  ownerPersonId: string;
  createdAt: string;
  updatedAt: string;
};

// ── Contacts ─────────────────────────────────────────────────────────────────────

export const CreateContactSchema = z.strictObject({
  companyId: uuid.nullable().optional(),
  firstName: z.string().trim().min(1).max(128),
  lastName: z.string().trim().min(1).max(128),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: nullableText(64),
  title: nullableText(128),
  department: nullableText(128),
});
export type CreateContactInput = z.infer<typeof CreateContactSchema>;

export const UpdateContactSchema = CreateContactSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'at least one field is required',
);
export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;

export type Contact = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  department: string | null;
  ownerPersonId: string;
  createdAt: string;
  updatedAt: string;
};

// ── Deals ────────────────────────────────────────────────────────────────────────

/** The six deal stages. Mirrors the deals.stage CHECK constraint in migration 0031. */
export const DEAL_STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DealStageSchema = z.enum(DEAL_STAGES);

/** List query for deals: pagination plus optional pipeline-stage and
 * related-record filters (U3). */
export const ListDealsQuerySchema = ListQuerySchema.extend({
  stage: DealStageSchema.optional(),
  companyId: uuid.optional(),
  contactId: uuid.optional(),
  pipelineId: uuid.optional(),
});
export type ListDealsQuery = z.infer<typeof ListDealsQuerySchema>;

const dealValue = z
  .union([
    z.string().regex(/^\d+(\.\d{1,4})?$/, 'value must be a non-negative decimal'),
    z.number().nonnegative(),
  ])
  .transform((v) => String(v));

export const CreateDealSchema = z.strictObject({
  title: z.string().trim().min(1).max(255),
  companyId: uuid.nullable().optional(),
  contactId: uuid.nullable().optional(),
  value: dealValue.nullable().optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((s) => s.toUpperCase())
    .default('INR'),
  stage: DealStageSchema.default('NEW'),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: dateString.nullable().optional(),
});
export type CreateDealInput = z.infer<typeof CreateDealSchema>;

export const UpdateDealSchema = CreateDealSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'at least one field is required',
);
export type UpdateDealInput = z.infer<typeof UpdateDealSchema>;

export type Deal = {
  id: string;
  title: string;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  value: string | null;
  currency: string;
  stage: DealStage;
  pipelineId: string | null;
  pipelineStageId: string | null;
  probability: number | null;
  ownerPersonId: string;
  expectedCloseDate: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ── Activities ───────────────────────────────────────────────────────────────────
// (Phase 2 Track B). Column contract with migration 0034:
//
//   activities: id, org_id, entity_type, entity_id, type, subject, notes,
//               occurred_at, due_at, owner_person_id,
//               created_at, updated_at, deleted_at (+ created_by/updated_by,
//               stamped by trigger — never written here)
//
// The (entity_type, entity_id) link is polymorphic with NO cross-table foreign
// keys (plan §3); the app layer probes the referenced record for visibility
// before every write (see src/lib/crm/refs.ts).

/** The four activity types. Mirrors the activities.type CHECK in migration 0034. */
export const ACTIVITY_TYPES = ['CALL', 'EMAIL', 'MEETING', 'NOTE'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);

/** Which CRM record an activity is logged against. Mirrors the
 * activities.entity_type CHECK in migration 0034. */
export const ACTIVITY_ENTITY_TYPES = ['company', 'contact', 'deal'] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export const ActivityEntityTypeSchema = z.enum(ACTIVITY_ENTITY_TYPES);

/** List query for activities: pagination plus optional entity and type filters. */
export const ListActivitiesQuerySchema = ListQuerySchema.extend({
  entityType: ActivityEntityTypeSchema.optional(),
  entityId: uuid.optional(),
  type: ActivityTypeSchema.optional(),
});
export type ListActivitiesQuery = z.infer<typeof ListActivitiesQuerySchema>;

/** ISO-8601 datetimes for occurredAt/dueAt. The client form converts
 * datetime-local inputs to full ISO strings before they reach this boundary. */
const activityDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid datetime')
  .refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s), 'must be an ISO-8601 datetime');

export const CreateActivitySchema = z.strictObject({
  entityType: ActivityEntityTypeSchema,
  entityId: uuid,
  type: ActivityTypeSchema,
  subject: z.string().trim().min(1).max(255),
  notes: nullableText(4000),
  occurredAt: activityDateTime.nullable().optional(),
  dueAt: activityDateTime.nullable().optional(),
});
export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;

/**
 * Partial update: every field optional, at least one required. The
 * (entityType, entityId) link is deliberately absent — an activity's target is
 * immutable after creation.
 */
export const UpdateActivitySchema = CreateActivitySchema.omit({
  entityType: true,
  entityId: true,
})
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateActivityInput = z.infer<typeof UpdateActivitySchema>;

export type Activity = {
  id: string;
  entityType: ActivityEntityType;
  entityId: string;
  type: ActivityType;
  subject: string;
  notes: string | null;
  occurredAt: string | null;
  dueAt: string | null;
  entityName: string | null;
  ownerPersonId: string;
  createdAt: string;
  updatedAt: string;
};

// ── Relationships ────────────────────────────────────────────────────────────────
// Migration 0035: explicit join tables between the CRM core records (NOT
// polymorphic). company_contacts associates contacts with companies (with a
// role and the primary flag); company_links and contact_links model
// company↔company and contact↔contact edges with typed directions.

/** company_links.link_type values — mirrors the CHECK constraint in 0035.
 * PARENT means fromCompany is the parent of toCompany. */
export const COMPANY_LINK_TYPES = ['PARENT', 'SUBSIDIARY', 'PARTNER'] as const;
export type CompanyLinkType = (typeof COMPANY_LINK_TYPES)[number];

/** contact_links.link_type values — mirrors the CHECK constraint in 0035. */
export const CONTACT_LINK_TYPES = ['COLLEAGUE', 'REFERRAL', 'OTHER'] as const;
export type ContactLinkType = (typeof CONTACT_LINK_TYPES)[number];

export const CompanyLinkTypeSchema = z.enum(COMPANY_LINK_TYPES);
export const ContactLinkTypeSchema = z.enum(CONTACT_LINK_TYPES);

/** List query for relationship lists: pagination plus an optional link-type filter. */
export const ListLinksQuerySchema = ListQuerySchema.extend({
  linkType: z.string().trim().max(32).optional(),
});
export type ListLinksQuery = z.infer<typeof ListLinksQuerySchema>;

/** Association of a contact with a company. contactName/contactEmail are
 * joined for display; role is free text, isPrimary marks the flagship. */
export const CreateCompanyContactSchema = z.strictObject({
  companyId: uuid,
  contactId: uuid,
  role: nullableText(128),
  isPrimary: z.boolean().default(false),
});
export type CreateCompanyContactInput = z.infer<typeof CreateCompanyContactSchema>;

/** Partial update: role and/or isPrimary, at least one required. Defined
 * explicitly (not via .pick().partial()) so isPrimary's create-time
 * .default(false) does not leak into updates and defeat the non-empty refine. */
export const UpdateCompanyContactSchema = z
  .strictObject({
    role: nullableText(128).optional(),
    isPrimary: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateCompanyContactInput = z.infer<typeof UpdateCompanyContactSchema>;

export type CompanyContact = {
  id: string;
  companyId: string;
  contactId: string;
  // Populated depending on which side is listed: the company-side list joins
  // the contact, the contact-side list joins the company.
  contactName: string | null;
  contactEmail: string | null;
  companyName: string | null;
  role: string | null;
  isPrimary: boolean;
  ownerPersonId: string;
  createdAt: string;
  updatedAt: string;
};

export const CreateCompanyLinkSchema = z
  .strictObject({
    fromCompanyId: uuid,
    toCompanyId: uuid,
    linkType: CompanyLinkTypeSchema,
  })
  .refine((v) => v.fromCompanyId !== v.toCompanyId, 'a company cannot link to itself');
export type CreateCompanyLinkInput = z.infer<typeof CreateCompanyLinkSchema>;

/** Company↔company edge. otherName is the display name of the company on the
 * far end of the edge relative to the listing company; direction tells which. */
export type CompanyLink = {
  id: string;
  fromCompanyId: string;
  toCompanyId: string;
  linkType: CompanyLinkType;
  direction: 'outgoing' | 'incoming';
  otherName: string;
  ownerPersonId: string;
  createdAt: string;
  updatedAt: string;
};

export const CreateContactLinkSchema = z
  .strictObject({
    fromContactId: uuid,
    toContactId: uuid,
    linkType: ContactLinkTypeSchema,
  })
  .refine((v) => v.fromContactId !== v.toContactId, 'a contact cannot link to itself');
export type CreateContactLinkInput = z.infer<typeof CreateContactLinkSchema>;

/** Contact↔contact edge. otherName/direction work like CompanyLink. */
export type ContactLink = {
  id: string;
  fromContactId: string;
  toContactId: string;
  linkType: ContactLinkType;
  direction: 'outgoing' | 'incoming';
  otherName: string;
  ownerPersonId: string;
  createdAt: string;
  updatedAt: string;
};

// ── Pipelines ────────────────────────────────────────────────────────────────────
// (Phase 3). Column contract with migration 0037:
//
//   pipelines: id, org_id, name, description, is_default,
//              created_at, updated_at, deleted_at
//              (+ created_by/updated_by, stamped by trigger — never written here)
//              Partial unique: exactly one live default per org.
//              Soft-delete via public.crm_soft_delete('pipeline', id).
//   pipeline_stages: id, org_id, pipeline_id, name, position,
//              probability numeric(5,2), color, is_won, is_lost, created_at
//              NO deleted_at — stages are append-only at runtime (hard-delete is
//              app_owner-only and the FK from deals blocks referenced stages).
//              UNIQUE (pipeline_id, position).
//   deal_stage_history: id, org_id, deal_id, from_stage_id (NULL = creation),
//              to_stage_id, changed_by, changed_at. Append-only.
//   deals gains pipeline_id (IMMUTABLE after set — DB trigger raises 42501)
//              and pipeline_stage_id. A DB trigger records every stage movement
//              in deal_stage_history; the service never writes history rows.
//
// Pipelines are org-level configuration, not owned records: no owner_person_id.
// Permission keys (module 'crm', seeded by 0037, granted to SUPER_ADMIN + ADMIN
// at GLOBAL): pipelines.view/create/edit/delete, pipeline_stages.manage.

/** List query for pipelines: pagination plus an optional name-prefix search. */
export const ListPipelinesQuerySchema = ListQuerySchema;
export type ListPipelinesQuery = ListQuery;

export const CreatePipelineSchema = z.strictObject({
  name: z.string().trim().min(1).max(1000),
  description: nullableText(2000),
  isDefault: z.boolean().default(false),
});
export type CreatePipelineInput = z.infer<typeof CreatePipelineSchema>;

/**
 * Partial update: every field optional, at least one required. Defined
 * explicitly (not via .partial()) so isDefault's create-time .default(false)
 * does not leak into updates and defeat the non-empty refine.
 */
export const UpdatePipelineSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(1000).optional(),
    description: nullableText(2000),
    isDefault: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdatePipelineInput = z.infer<typeof UpdatePipelineSchema>;

export type Pipeline = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A pipeline with its stages in position order. */
export type PipelineWithStages = Pipeline & {
  stages: PipelineStage[];
};

/** Pipeline list row: the pipeline plus its live stage count. */
export type PipelineListRow = Pipeline & {
  stageCount: number;
};

const stageProbability = z.number().min(0).max(100);
const stageColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB hex')
  .nullable()
  .optional();

/** A stage refuses to be both terminal states; the DB CHECK is the backstop. */
const notBothTerminal = <T extends { isWon?: boolean; isLost?: boolean }>(v: T) =>
  !(v.isWon && v.isLost);

export const CreatePipelineStageSchema = z
  .strictObject({
    pipelineId: uuid,
    name: z.string().trim().min(1).max(255),
    position: z.number().int().min(0).optional(),
    probability: stageProbability.default(0),
    color: stageColor,
    isWon: z.boolean().default(false),
    isLost: z.boolean().default(false),
  })
  .refine(notBothTerminal, 'a stage cannot be both won and lost');
export type CreatePipelineStageInput = z.infer<typeof CreatePipelineStageSchema>;

/**
 * Partial update: every field optional, at least one required. Defined
 * explicitly so the create-time defaults do not leak into updates, and
 * pipelineId is absent — a stage never changes pipeline.
 */
export const UpdatePipelineStageSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255).optional(),
    position: z.number().int().min(0).optional(),
    probability: stageProbability.optional(),
    color: stageColor,
    isWon: z.boolean().optional(),
    isLost: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .refine(notBothTerminal, 'a stage cannot be both won and lost');
export type UpdatePipelineStageInput = z.infer<typeof UpdatePipelineStageSchema>;

export type PipelineStage = {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  /** numeric(5,2) arrives as a string, like Deal.value. */
  probability: string;
  color: string | null;
  isWon: boolean;
  isLost: boolean;
  createdAt: string;
};

/** Move a deal to another stage of its own pipeline. */
export const MoveDealToStageSchema = z.strictObject({
  stageId: uuid,
});
export type MoveDealToStageInput = z.infer<typeof MoveDealToStageSchema>;

export type MoveDealResult = {
  ok: true;
  dealId: string;
  /** The stage the deal left; null when the deal had no stage yet. */
  fromStageId: string | null;
  toStageId: string;
};

/** One per-stage forecast row. Money values are numeric strings. */
export type ForecastStageRow = {
  stageId: string;
  stageName: string;
  position: number;
  probability: string;
  dealCount: number;
  totalValue: string;
  weightedValue: string;
};

export type Forecast = {
  stages: ForecastStageRow[];
  totals: {
    dealCount: number;
    totalValue: string;
    weightedValue: string;
  };
};

/** One per-stage velocity row. avgDays is null where no completed stay exists. */
export type VelocityStageRow = {
  stageId: string;
  stageName: string;
  position: number;
  avgDays: number | null;
  sampleCount: number;
  entriesCount: number;
  exitsCount: number;
  /** Transitions into this stage from the immediately preceding stage. */
  convertedFromPrevious: number;
};

export type Velocity = {
  stages: VelocityStageRow[];
};
