-- PRAVSHI OS — Phase 8: Search & Notifications — trigram search indexes.
--
-- EXTENSION PROVISIONING (audit §7 privilege decision): pg_trgm is a
-- database-level extension installed ONCE PER BRANCH by the branch owner in
-- scripts/db/roles.sql (like pgcrypto) — NOT in this migration. The standing
-- roles.sql rule is that extensions are database-level objects and the
-- Drizzle migration role (app_owner) must not need superuser; app_owner
-- holds GRANT CREATE ON DATABASE (enough for the trusted pg_trgm
-- extension), but uniformity with pgcrypto keeps all extensions on the
-- branch-owner path. The verification block below fails this migration
-- CLOSED if pg_trgm is absent, so a skipped roles.sql step can never
-- produce a half-indexed database.
--
-- INDEX SHAPE (audit §7): one GIN trigram index per searchable entity,
-- partial on WHERE deleted_at IS NULL so soft-deleted rows never match.
-- Existing prefix-ILIKE list filters are untouched (leading constants keep
-- the btree indexes usable); these GIN indexes serve the global search's
-- trigram-similarity ranking tier.
--
-- PII RULE (0017): the people index covers full_legal_name, preferred_name
-- and work_email ONLY. personal_email, phone and date_of_birth are
-- deliberately excluded — a search index must not make HR-only PII
-- searchable by trigram similarity.

create index companies_search_trgm on public.companies
  using gin ((name || ' ' || coalesce(domain::text, '') || ' ' || coalesce(industry, '')) gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index contacts_search_trgm on public.contacts
  using gin ((first_name || ' ' || coalesce(last_name, '') || ' ' || coalesce(email::text, '')) gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index people_search_trgm on public.people
  using gin ((full_legal_name || ' ' || coalesce(preferred_name, '') || ' ' || coalesce(work_email::text, '')) gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index deals_search_trgm on public.deals
  using gin (title gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index work_tasks_search_trgm on public.work_tasks
  using gin (title gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index work_projects_search_trgm on public.work_projects
  using gin (name gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index workflows_search_trgm on public.workflows
  using gin (name gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

create index activities_search_trgm on public.activities
  using gin (subject gin_trgm_ops)
  where deleted_at is null;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- Verification: fail the migration rather than leave search half-indexed
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    raise exception 'Phase 8 search migration: the pg_trgm extension is not installed. '
      'Install it once per branch via scripts/db/roles.sql (branch-owner step, like pgcrypto) '
      'before applying this migration.';
  end if;

  select string_agg('trigram index missing or not GIN: ' || idx, '; ') into v_problems
  from (values
    ('companies_search_trgm'),
    ('contacts_search_trgm'),
    ('people_search_trgm'),
    ('deals_search_trgm'),
    ('work_tasks_search_trgm'),
    ('work_projects_search_trgm'),
    ('workflows_search_trgm'),
    ('activities_search_trgm')
  ) as want(idx)
  where not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = want.idx
      and indexdef ilike '%using gin%'
  );

  if v_problems is not null then
    raise exception 'search index verification failed: %', v_problems;
  end if;
end;
$$;
