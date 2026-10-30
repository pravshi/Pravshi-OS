/**
 * Every table's data class (target-architecture.md Step 3), checked against the database by
 * tests/guards/security-inventory.test.ts.
 *
 *   tenant       one organization's data. `org` names what scopes a row: the org_id column, the
 *                organization's own id (organizations), or a foreign key to a tenant parent
 *                (role_permissions). Needs enabled and forced RLS, a policy for every runtime
 *                login that holds a privilege on it, every such policy scoped by authz.org_id()
 *                (or a reviewed exception), and a test that proves two-organization isolation —
 *                or an entry in ISOLATION_TEST_GAPS.
 *   global       reference data intentionally shared by every organization; no org_id.
 *   platform     control-plane data (ADR-008); no runtime login holds a privilege on it.
 *   operational  infrastructure state. A runtime login may hold a privilege on it only when it is
 *                named in `access` (the Better Auth credential store, app_auth only).
 *   public-projection  none yet.
 *
 * A table missing here, or an entry for a table that no longer exists, fails the guard.
 */

export type Org = 'org_id' | 'id' | { readonly via: string; readonly parent: string };
export interface IsolationTest {
  /** Repository-relative test file. */
  readonly file: string;
  /** The exact title of the it()/test() block that asserts isolation for this table. */
  readonly title: string;
}
export type Classification =
  | { readonly class: 'tenant'; readonly org: Org; readonly isolationTest?: IsolationTest }
  | { readonly class: 'global' | 'platform' | 'public-projection' }
  | { readonly class: 'operational'; readonly access?: readonly string[] };

export const TABLES: Readonly<Record<string, Classification>> = {
  // ── tenant-owned: org_id (or the stated owner) scopes every row ──
  'public.activities': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-activities.test.ts',
      title: 'cross-tenant insert is rejected: org must match the identity',
    },
  },
  'public.ai_org_limits': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/ai-usage.test.ts',
      title: 'shows the row only to ai.usage.view holders in the same org',
    },
  },
  'public.ai_usage_requests': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/ai-usage.test.ts',
      title: 'shows org rows to ai.usage.view, and never another org’s rows',
    },
  },
  'public.audit_logs': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/audit-logs.test.ts',
      title: 'cannot be made to name an actor from another organization',
    },
  },
  'public.companies': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-core.test.ts',
      title: 'insert into another org is denied',
    },
  },
  'public.company_contacts': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-relationships.test.ts',
      title: 'inserting with a foreign org claim is denied by RLS',
    },
  },
  'public.company_links': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-relationships.test.ts',
      title: 'a cross-org company link is rejected by the composite FK',
    },
  },
  'public.contact_links': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-relationships.test.ts',
      title: 'a cross-org contact link is rejected by the composite FK',
    },
  },
  'public.contacts': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/analytics/tenant-isolation.test.ts',
      title: 'alice’s identity sees exactly Org A rows in every analytics table',
    },
  },
  'public.crm_import_decisions': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-import-decisions.test.ts',
      title: 'decisions and plans: tenant isolation, importer-only writes',
    },
  },
  'public.crm_import_row_plans': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-import-decisions.test.ts',
      title: 'decisions and plans: tenant isolation, importer-only writes',
    },
  },
  'public.crm_import_rows': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-imports.test.ts',
      title: 'isolates organizations and requires crm.import (AC-S2, AC-S3)',
    },
  },
  'public.crm_imports': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-imports.test.ts',
      title: 'isolates organizations and requires crm.import (AC-S2, AC-S3)',
    },
  },
  'public.deal_stage_history': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-pipelines.test.ts',
      title: 'a viewer in orgB sees exactly orgB’s pipelines, stages and history',
    },
  },
  'public.deals': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-core.test.ts',
      title: 'a deal naming a contact from another org is rejected (the MATCH SIMPLE hole)',
    },
  },
  'public.departments': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/departments-teams.test.ts',
      title: 'never returns another tenant departments',
    },
  },
  'public.engagement_events': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/engagement-events.test.ts',
      title: 'denies a cross-tenant claim',
    },
  },
  'public.engagements': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: { file: 'tests/db/engagements.test.ts', title: 'denies a cross-tenant claim' },
  },
  'public.identity_counters': { class: 'tenant', org: 'org_id' },
  'public.integration_connections': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/integrations-rls.test.ts',
      title: 'connections: org B is invisible and untouchable from org A',
    },
  },
  'public.integration_inbound_events': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/integrations-rls.test.ts',
      title: 'inbound events: cross-tenant rows are invisible',
    },
  },
  'public.integration_sync_checkpoints': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/integrations-rls.test.ts',
      title: 'checkpoints: cross-tenant rows are invisible',
    },
  },
  'public.integration_webhook_deliveries': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/integrations-rls.test.ts',
      title: 'deliveries: cross-tenant rows are invisible',
    },
  },
  'public.integration_webhook_subscriptions': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/integrations-rls.test.ts',
      title: 'subscriptions: org B is invisible and untouchable from org A',
    },
  },
  'public.internships': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: { file: 'tests/db/internships.test.ts', title: 'denies a cross-tenant claim' },
  },
  'public.invitation_roles': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/integration/invitations.test.ts',
      title: 'rejects an invitation carrying a role from another organization',
    },
  },
  'public.invitations': { class: 'tenant', org: 'org_id' },
  'public.job_email_content': { class: 'tenant', org: 'org_id' },
  'public.jobs': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/jobs/jobs-rls.test.ts',
      title: 'insert: cross-org insert fails with 42501',
    },
  },
  'public.login_events': { class: 'tenant', org: 'org_id' },
  'public.notification_preferences': { class: 'tenant', org: 'org_id' },
  'public.notifications': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: { file: 'tests/notifications/integration.test.ts', title: 'isolates tenants' },
  },
  'public.people': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/organizations-people.test.ts',
      title: 'a person in another organization cannot be read',
    },
  },
  'public.person_departments': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/departments-teams.test.ts',
      title: 'refuses a person_department crossing organizations',
    },
  },
  'public.person_roles': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/roles-permissions.test.ts',
      title: 'blocks a granted_by from another organization',
    },
  },
  'public.pipeline_stages': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-pipelines.test.ts',
      title: 'cross-tenant stage insert is rejected: org must match the identity',
    },
  },
  'public.pipelines': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/crm-pipelines.test.ts',
      title: 'cross-tenant pipeline insert is rejected: org must match the identity',
    },
  },
  'public.project_members': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/project-members.test.ts',
      title: 'denies cross-tenant reads and writes on project_members',
    },
  },
  'public.record_grants': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/record-grants.test.ts',
      title: 'returns zero rows across tenants',
    },
  },
  'public.roles': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/roles-permissions.test.ts',
      title: 'refuses a SUPER_ADMIN from another organization',
    },
  },
  'public.schedules': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/jobs/jobs-rls.test.ts',
      title: 'insert: schedule whose workflow belongs to another org',
    },
  },
  'public.task_reminders': { class: 'tenant', org: 'org_id' },
  'public.team_members': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/departments-teams.test.ts',
      title: 'refuses a team member whose person is in another organization',
    },
  },
  'public.teams': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/departments-teams.test.ts',
      title: 'refuses a team lead from another organization',
    },
  },
  'public.work_projects': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/work-projects.test.ts',
      title: "org B cannot select org A's projects",
    },
  },
  'public.work_tasks': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/db/work-tasks.test.ts',
      title: "org B cannot select org A's tasks",
    },
  },
  'public.workflow_execution_steps': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/workflows/workflow-rls.test.ts',
      title: 'step whose org differs from its execution org → 42501',
    },
  },
  'public.workflow_executions': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/workflows/workflow-rls.test.ts',
      title: 'executions select: cross-tenant read → zero rows',
    },
  },
  'public.workflows': {
    class: 'tenant',
    org: 'org_id',
    isolationTest: {
      file: 'tests/integration/workflow-api.test.ts',
      title: 'lists only the caller org workflows (tenant isolation)',
    },
  },
  'public.organizations': { class: 'tenant', org: 'id' },
  'public.role_permissions': {
    class: 'tenant',
    org: { via: 'role_id', parent: 'public.roles' },
    isolationTest: {
      file: 'tests/db/roles-permissions.test.ts',
      title: 'puts org_id where a second organization could disagree, and nowhere else',
    },
  },
  // ── global reference: intentionally shared by every organization ──
  'public.organization_type_templates': { class: 'global' },
  'public.organization_types': { class: 'global' },
  'public.permissions': { class: 'global' },
  // ── operational ──
  'public.bootstrap_setup_token': { class: 'operational' },
  'public.bootstrap_state': { class: 'operational' },
  'auth.auth_accounts': { class: 'operational', access: ['app_auth'] },
  'auth.auth_rate_limits': { class: 'operational', access: ['app_auth'] },
  'auth.auth_sessions': { class: 'operational', access: ['app_auth'] },
  'auth.auth_two_factors': { class: 'operational', access: ['app_auth'] },
  'auth.auth_users': { class: 'operational', access: ['app_auth'] },
  'auth.auth_verifications': { class: 'operational', access: ['app_auth'] },
  'auth.api_rate_limits': { class: 'operational' },
  'auth.login_lockouts': { class: 'operational' },
  'auth.password_resets': { class: 'operational' },
  'drizzle.__drizzle_migrations': { class: 'operational' },
  // ── platform (control plane, ADR-008) ──
  'platform.admin_invite_requests': { class: 'platform' },
  'platform.admin_permissions': { class: 'platform' },
  'platform.admins': { class: 'platform' },
  'platform.audit_events': { class: 'platform' },
  'platform.bootstrap_state': { class: 'platform' },
  'platform.org_admin_setup': { class: 'platform' },
  'platform.permissions': { class: 'platform' },
  'platform.provisioning_requests': { class: 'platform' },
  'platform.setup_tokens': { class: 'platform' },
};

/**
 * Tenant tables with no two-organization isolation test, at main 51e6efe. Shrink-only: a table
 * listed here that gains an isolationTest, or is no longer a tenant table, fails the guard — remove
 * it in the same change. Each is a finding of Step 3; none is fixed by it.
 */
export const ISOLATION_TEST_GAPS: readonly string[] = [
  // per-organization counters are asserted through authz.next_identity_code() in tests/db/identity-counters.test.ts, which never names the table; app_user holds no privilege on it
  'public.identity_counters',
  // cross-organization role and department references are refused at the API (tests/integration/invitations.test.ts); no test reads invitations as another organization
  'public.invitations',
  // definer-only (worker plane); app_user holds no privilege on it; no two-organization test
  'public.job_email_content',
  // read policy is self-scoped by login (login_events_select_self), not by organization; no two-organization test
  'public.login_events',
  // no two-organization test
  'public.notification_preferences',
  // the tenant root; its policies call authz.org_id(); no test reads another organization’s row
  'public.organizations',
  // no two-organization test of the table itself
  'public.task_reminders',
];

/**
 * Runtime-login policies on tenant tables that are not scoped by authz.org_id(), each reviewed.
 * Key: `<schema.table>/<policy>`.
 */
export const POLICY_SCOPE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'public.login_events/login_events_select_self':
    'self-scoped: a login reads only its own events (auth_user_id of the caller’s person); one login belongs to one organization (ADR-007 GOV-02)',
};
