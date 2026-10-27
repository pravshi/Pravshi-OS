-- ═════════════════════════════════════════════════════════════════════════════════
-- PRAVSHI OS — 0081: Sales Sheet import persistence (BP-06)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
--
-- The stored half of the V1 Sales Sheet import (proposal
-- docs/architecture/proposals/2026-10-16-sales-sheet-import.md). The file is parsed and
-- previewed in the application (src/lib/import/sales-sheet/); this migration keeps what the
-- preview produced, lets the importer confirm it, and lets a background job commit it.
--
--   public.crm_imports       one import: the file's name and SHA-256, the mapping it was
--                            read with, its header row, the preview counts, a status and the
--                            final counts. The raw file is never stored (AC-A3).
--   public.crm_import_rows   one row per source row: its original values, its preview plan
--                            or errors, and — once committed — what it became and the ids of
--                            the records it created or linked to (AC-A2). Unique per
--                            (import, row number): each source row is applied at most once
--                            (AC-I2).
--   permission crm.import    required, in addition to the create permission of every table
--                            the file writes (checked by the application, AC-S1). Seeded to
--                            SUPER_ADMIN and ADMIN at GLOBAL (AC-S4, proposed — founder Q8).
--   job type crm_import      the background commit (AC-C1). A job's payload names the import
--                            only; crm_import_execute_as_job() returns the verified principal.
--
-- THE TRUST RULES (enforced here, not only in the application)
--
--   * Organization and importer come from the transaction identity: created_by is stamped
--     from authz.person_id(), never accepted from the caller (AC-S2).
--   * Only holders of crm.import in the same organization see or change import records — a
--     GLOBAL holder all of them, a narrower holder only their own — and only the importer
--     changes their own import (AC-S3). No runtime role may delete.
--   * What the preview recorded is immutable: file, hash, mapping, header, counts and every
--     row's source values and plan. Statuses move only forward:
--       PREVIEWED → QUEUED | CANCELLED
--       QUEUED    → RUNNING | FAILED | CANCELLED
--       RUNNING   → RUNNING | COMPLETED | COMPLETED_WITH_ERRORS | FAILED
--     and a row is decided once, while its import is RUNNING (PENDING → CREATED | LINKED |
--     SKIPPED | FAILED). Completion counts are computed here from the rows and must add up to
--     the file's row count (AC-C3).
--   * The CRM records themselves are written through the CRM's own tables, policies and
--     triggers as the importer — this migration grants nothing on companies, contacts or deals.
--   * Two changes need no person, and nothing else does: the job foreign key's ON DELETE SET
--     NULL once the job is really gone (job retention keeps working; the import and its audit
--     entries survive the job), and a failure recorded by the worker plane through the
--     definers below (an import never stays QUEUED or RUNNING without an outcome). A failure
--     is a fixed code, never free text.
--
-- WHAT IS NOT HERE
--
--   * Retention (AC-A3, proposed 90 days — founder Q7): expires_at is recorded; the sweep that
--     removes expired imports is a separate, approved change.
--   * The real Sales Sheet mapping (founder Q1, Q2, Q4, Q9).
--
-- Rollback: scripts/db/rollback/0081_crm_imports.down.sql restores 0080.

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the crm.import permission
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Sensitive, like contacts.export and deals.export: it moves personal data in bulk.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
values ('crm.import', 'crm', 'import', 'crm',
        'Import companies, contacts and deals from a Sales Sheet file', true);

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the crm_import job type
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('workflow_run', 'scheduled_trigger', 'retry',
                  'webhook', 'cleanup', 'notification', 'email', 'crm_import'));

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the import tables
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.crm_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  created_by uuid not null,
  file_name text not null,
  file_sha256 text not null,
  mapping_id text not null,
  header jsonb not null,
  data_rows integer not null,
  preview_counts jsonb not null,
  status text not null default 'PREVIEWED',
  allow_reimport boolean not null default false,
  created_count integer not null default 0,
  linked_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  job_id uuid,
  failure_reason text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '90 days',
  constraint crm_imports_id_org_unique unique (id, org_id),
  constraint crm_imports_creator_fk foreign key (created_by, org_id)
    references public.people (id, org_id),
  constraint crm_imports_job_fk foreign key (org_id, job_id)
    references public.jobs (org_id, id) on delete set null (job_id),
  constraint crm_imports_file_name_valid
    check (length(btrim(file_name)) between 1 and 255 and file_name !~ '[[:cntrl:]]'),
  constraint crm_imports_sha256_format check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint crm_imports_mapping_id_format check (mapping_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  constraint crm_imports_header_valid
    check (jsonb_typeof(header) = 'array' and jsonb_array_length(header) between 1 and 200),
  constraint crm_imports_data_rows_range check (data_rows between 0 and 10000),
  constraint crm_imports_preview_counts_object check (jsonb_typeof(preview_counts) = 'object'),
  constraint crm_imports_status_valid check (status in (
    'PREVIEWED', 'QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED',
    'CANCELLED')),
  constraint crm_imports_counts_non_negative check (
    created_count >= 0 and linked_count >= 0 and skipped_count >= 0 and failed_count >= 0),
  constraint crm_imports_completed_counts_add_up check (
    status not in ('COMPLETED', 'COMPLETED_WITH_ERRORS')
    or created_count + linked_count + skipped_count + failed_count = data_rows),
  -- A fixed code (UNKNOWN_MAPPING, IMPORTER_NOT_PERMITTED, COMMIT_ERROR, JOB_ENDED, …), never
  -- free text: nothing from the file or from a database error can be stored here.
  constraint crm_imports_failure_reason_code check (failure_reason ~ '^[A-Z][A-Z_]{2,39}$')
);

comment on table public.crm_imports is
  'Sales Sheet imports (0081, BP-06): one row per uploaded file. The raw file is never kept.';

create index crm_imports_org_sha_idx on public.crm_imports (org_id, file_sha256);
create index crm_imports_org_created_idx on public.crm_imports (org_id, created_at desc);
-- Serves the ON DELETE SET NULL lookup when retention deletes a job.
create index crm_imports_org_job_idx on public.crm_imports (org_id, job_id)
  where job_id is not null;

create table public.crm_import_rows (
  org_id uuid not null,
  import_id uuid not null,
  row_number integer not null,
  source_values jsonb not null,
  status text not null,
  errors jsonb not null default '[]'::jsonb,
  planned_company text,
  planned_contact text,
  planned_deal text,
  company_key text,
  contact_key text,
  include boolean not null default false,
  company_id uuid,
  contact_id uuid,
  deal_id uuid,
  processed_at timestamptz,
  primary key (import_id, row_number),
  constraint crm_import_rows_import_fk foreign key (import_id, org_id)
    references public.crm_imports (id, org_id),
  constraint crm_import_rows_company_fk foreign key (company_id, org_id)
    references public.companies (id, org_id),
  constraint crm_import_rows_contact_fk foreign key (contact_id, org_id)
    references public.contacts (id, org_id),
  constraint crm_import_rows_deal_fk foreign key (deal_id, org_id)
    references public.deals (id, org_id),
  constraint crm_import_rows_row_number_range check (row_number between 2 and 10001),
  constraint crm_import_rows_values_array check (
    jsonb_typeof(source_values) = 'array' and jsonb_array_length(source_values) <= 200),
  constraint crm_import_rows_status_valid
    check (status in ('PENDING', 'CREATED', 'LINKED', 'SKIPPED', 'FAILED')),
  constraint crm_import_rows_errors_array check (jsonb_typeof(errors) = 'array'),
  constraint crm_import_rows_failed_has_reason
    check (status <> 'FAILED' or jsonb_array_length(errors) > 0),
  constraint crm_import_rows_plan_valid check (
    coalesce(planned_company, 'CREATE') in ('CREATE', 'LINK', 'POSSIBLE_DUPLICATE')
    and coalesce(planned_contact, 'CREATE') in ('CREATE', 'LINK', 'POSSIBLE_DUPLICATE')
    and coalesce(planned_deal, 'CREATE') in ('CREATE', 'LINK', 'POSSIBLE_DUPLICATE'))
);

comment on table public.crm_import_rows is
  'One source row of a Sales Sheet import (0081): original values, preview plan or errors, '
  'and the records it created or linked to. Applied at most once.';

create index crm_import_rows_pending_idx on public.crm_import_rows (import_id, row_number)
  where status = 'PENDING';
-- The commit links a row to the record an earlier row of the same key created: one lookup per
-- row, which without these scans the whole import (10,000 × 10,000 at the row limit).
create index crm_import_rows_company_key_idx on public.crm_import_rows (import_id, company_key)
  where company_id is not null;
create index crm_import_rows_contact_key_idx on public.crm_import_rows (import_id, contact_key)
  where contact_id is not null;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 4 — the guards
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER so that the counts and the parent checks see every row of the import,
-- whatever the caller's visibility; the identity they compare against is the caller's own.

create function public.crm_imports_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_cmp public.crm_imports;
  v_pending integer;
  v_created integer;
  v_linked integer;
  v_skipped integer;
  v_failed integer;
begin
  -- The one change no person makes: deleting a referenced job (data retention, the cleanup
  -- job) nulls job_id through the foreign key's ON DELETE SET NULL. Accepted only when that job
  -- no longer exists and nothing else changes, so it can never unbind a live import; the
  -- import keeps its record, and its audit entries keep the job id.
  if tg_op = 'UPDATE' and old.job_id is not null and new.job_id is null then
    v_cmp := old;
    v_cmp.job_id := null;
    if new is not distinct from v_cmp
       and not exists (select 1 from public.jobs j where j.id = old.job_id) then
      return new;
    end if;
    raise exception 'crm_imports: job_id is cleared only when its job is deleted'
      using errcode = '23514';
  end if;

  -- The worker plane records a failure, and nothing else: no person, the worker's login (it
  -- holds no privilege on this table, so only the 0081 definers reach here), QUEUED or RUNNING
  -- to FAILED with a reason code, every other column unchanged.
  if tg_op = 'UPDATE' and v_person is null and session_user = 'app_worker' then
    v_cmp := old;
    v_cmp.status := new.status;
    v_cmp.failure_reason := new.failure_reason;
    v_cmp.completed_at := new.completed_at;
    if old.status in ('QUEUED', 'RUNNING') and new.status = 'FAILED'
       and new.failure_reason is not null and new is not distinct from v_cmp then
      -- What the committed batches did stays visible (AC-C3).
      select count(*) filter (where r.status = 'CREATED'),
             count(*) filter (where r.status = 'LINKED'),
             count(*) filter (where r.status = 'SKIPPED'),
             count(*) filter (where r.status = 'FAILED')
        into v_created, v_linked, v_skipped, v_failed
      from public.crm_import_rows r
      where r.import_id = old.id;
      new.created_count := v_created;
      new.linked_count := v_linked;
      new.skipped_count := v_skipped;
      new.failed_count := v_failed;
      new.completed_at := now();
      return new;
    end if;
    raise exception 'crm_imports: the worker plane only records failures' using errcode = '42501';
  end if;

  if v_person is null or new.org_id is distinct from authz.org_id() then
    raise exception 'crm_imports: not permitted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'PREVIEWED' or new.job_id is not null or new.allow_reimport
       or new.created_count <> 0 or new.linked_count <> 0 or new.skipped_count <> 0
       or new.failed_count <> 0 or new.confirmed_at is not null or new.started_at is not null
       or new.completed_at is not null or new.failure_reason is not null then
      raise exception 'crm_imports: a new import starts as a bare PREVIEWED record'
        using errcode = '23514';
    end if;
    new.created_by := v_person;
    new.created_at := now();
    new.expires_at := now() + interval '90 days';
    return new;
  end if;

  -- UPDATE: only the importer, and never the recorded preview.
  if v_person is distinct from old.created_by then
    raise exception 'crm_imports: only the importer may change an import' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id
     or new.created_by is distinct from old.created_by
     or new.file_name is distinct from old.file_name
     or new.file_sha256 is distinct from old.file_sha256
     or new.mapping_id is distinct from old.mapping_id
     or new.header is distinct from old.header
     or new.data_rows is distinct from old.data_rows
     or new.preview_counts is distinct from old.preview_counts
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'crm_imports: the recorded preview is immutable' using errcode = '23514';
  end if;
  -- job_id is set once, by the confirmation (PREVIEWED → QUEUED), and never by hand otherwise.
  if new.job_id is distinct from old.job_id
     and not (old.job_id is null and old.status = 'PREVIEWED' and new.status = 'QUEUED') then
    raise exception 'crm_imports: job_id is set once, by the confirmation' using errcode = '23514';
  end if;
  -- The lifecycle columns are this guard's: the caller's values are ignored, and each is set on
  -- its own transition below. failure_reason only arrives with a move to FAILED.
  if new.failure_reason is distinct from old.failure_reason
     and not (new.status = 'FAILED' and old.status <> 'FAILED') then
    raise exception 'crm_imports: failure_reason is recorded with the failure' using errcode = '23514';
  end if;
  new.confirmed_at := old.confirmed_at;
  new.started_at := old.started_at;
  new.completed_at := old.completed_at;
  if new.allow_reimport is distinct from old.allow_reimport and old.status <> 'PREVIEWED' then
    raise exception 'crm_imports: allow_reimport is decided at confirmation' using errcode = '23514';
  end if;

  if not (
    (old.status = 'PREVIEWED' and new.status in ('PREVIEWED', 'QUEUED', 'CANCELLED'))
    or (old.status = 'QUEUED' and new.status in ('RUNNING', 'FAILED', 'CANCELLED'))
    or (old.status = 'RUNNING'
        and new.status in ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'))
  ) then
    raise exception 'crm_imports: % → % is not allowed', old.status, new.status
      using errcode = '23514';
  end if;

  if new.status = 'QUEUED' and old.status = 'PREVIEWED' then
    if new.job_id is null then
      raise exception 'crm_imports: a queued import names its job' using errcode = '23514';
    end if;
    new.confirmed_at := now();
  end if;
  if new.status = 'RUNNING' and old.status = 'QUEUED' then
    new.started_at := now();
  end if;

  -- Counts are never written by the caller: they are the rows' own outcomes.
  if new.created_count <> old.created_count or new.linked_count <> old.linked_count
     or new.skipped_count <> old.skipped_count or new.failed_count <> old.failed_count then
    raise exception 'crm_imports: counts are computed, never written' using errcode = '23514';
  end if;
  if new.status = 'FAILED' and old.status <> 'FAILED' then
    -- A failed import still reports what its committed batches did (AC-C3); rows never decided
    -- are in none of the counts.
    select count(*) filter (where r.status = 'CREATED'),
           count(*) filter (where r.status = 'LINKED'),
           count(*) filter (where r.status = 'SKIPPED'),
           count(*) filter (where r.status = 'FAILED')
      into v_created, v_linked, v_skipped, v_failed
    from public.crm_import_rows r
    where r.import_id = old.id;
    new.created_count := v_created;
    new.linked_count := v_linked;
    new.skipped_count := v_skipped;
    new.failed_count := v_failed;
  end if;
  if new.status in ('COMPLETED', 'COMPLETED_WITH_ERRORS') then
    select count(*) filter (where r.status = 'PENDING'),
           count(*) filter (where r.status = 'CREATED'),
           count(*) filter (where r.status = 'LINKED'),
           count(*) filter (where r.status = 'SKIPPED'),
           count(*) filter (where r.status = 'FAILED')
      into v_pending, v_created, v_linked, v_skipped, v_failed
    from public.crm_import_rows r
    where r.import_id = old.id;
    if v_pending > 0 then
      raise exception 'crm_imports: % rows are still pending', v_pending using errcode = '23514';
    end if;
    if (new.status = 'COMPLETED') <> (v_failed = 0) then
      raise exception 'crm_imports: % does not match % failed rows', new.status, v_failed
        using errcode = '23514';
    end if;
    new.created_count := v_created;
    new.linked_count := v_linked;
    new.skipped_count := v_skipped;
    new.failed_count := v_failed;
    new.completed_at := now();
  end if;
  if new.status = 'FAILED' and old.status <> 'FAILED' then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

comment on function public.crm_imports_guard() is
  'BEFORE INSERT/UPDATE on crm_imports (0081): stamps the importer, keeps the preview '
  'immutable, allows only forward status moves by the importer, computes completion counts.';

revoke all on function public.crm_imports_guard() from public;

create trigger crm_imports_guard
  before insert or update on public.crm_imports
  for each row execute function public.crm_imports_guard();

create function public.crm_import_rows_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_import_status text;
  v_import_creator uuid;
begin
  -- One refusal for every reason — another organization, no such import, not the importer — so
  -- the guard cannot tell a caller whether an import id exists elsewhere.
  if v_person is null or new.org_id is distinct from authz.org_id() then
    raise exception 'crm_import_rows: not permitted' using errcode = '42501';
  end if;
  select i.status, i.created_by into v_import_status, v_import_creator
  from public.crm_imports i
  where i.id = new.import_id and i.org_id = new.org_id;
  if not found or v_person is distinct from v_import_creator then
    raise exception 'crm_import_rows: not permitted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if v_import_status <> 'PREVIEWED' then
      raise exception 'crm_import_rows: rows are recorded with the preview only'
        using errcode = '23514';
    end if;
    if new.status not in ('PENDING', 'FAILED') or new.include
       or new.company_id is not null or new.contact_id is not null or new.deal_id is not null
       or new.processed_at is not null then
      raise exception 'crm_import_rows: a new row is PENDING or FAILED and decides nothing yet'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id or new.import_id is distinct from old.import_id
     or new.row_number is distinct from old.row_number
     or new.source_values is distinct from old.source_values
     or new.planned_company is distinct from old.planned_company
     or new.planned_contact is distinct from old.planned_contact
     or new.planned_deal is distinct from old.planned_deal
     or new.company_key is distinct from old.company_key
     or new.contact_key is distinct from old.contact_key then
    raise exception 'crm_import_rows: the recorded row is immutable' using errcode = '23514';
  end if;

  if new.include is distinct from old.include then
    if v_import_status <> 'PREVIEWED' or old.status <> 'PENDING'
       or 'POSSIBLE_DUPLICATE' not in (coalesce(old.planned_company, ''),
                                        coalesce(old.planned_contact, ''),
                                        coalesce(old.planned_deal, '')) then
      raise exception 'crm_import_rows: only a possible duplicate is included, before commit'
        using errcode = '23514';
    end if;
  end if;

  if new.status is distinct from old.status then
    if old.status <> 'PENDING' or v_import_status <> 'RUNNING'
       or new.status not in ('CREATED', 'LINKED', 'SKIPPED', 'FAILED') then
      raise exception 'crm_import_rows: a row is decided once, while its import runs'
        using errcode = '23514';
    end if;
    new.processed_at := now();
  elsif new.company_id is distinct from old.company_id
        or new.contact_id is distinct from old.contact_id
        or new.deal_id is distinct from old.deal_id
        or new.errors is distinct from old.errors
        or new.processed_at is distinct from old.processed_at then
    raise exception 'crm_import_rows: outcomes are recorded with the decision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.crm_import_rows_guard() is
  'BEFORE INSERT/UPDATE on crm_import_rows (0081): only the importer writes; rows are '
  'recorded with the preview, immutable after, and decided once while the import runs.';

revoke all on function public.crm_import_rows_guard() from public;

create trigger crm_import_rows_guard
  before insert or update on public.crm_import_rows
  for each row execute function public.crm_import_rows_guard();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 5 — row-level security
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.crm_imports enable row level security;
alter table public.crm_imports force row level security;
alter table public.crm_import_rows enable row level security;
alter table public.crm_import_rows force row level security;

create policy crm_imports_owner_all on public.crm_imports
  for all to app_owner using (true) with check (true);
create policy crm_import_rows_owner_all on public.crm_import_rows
  for all to app_owner using (true) with check (true);

-- Scope (founder decision pending, implementation record E12): a GLOBAL holder of crm.import
-- sees every import of the organization; a holder at any narrower scope sees only the imports
-- they created — an import's rows hold source values (personal data), and "import at SELF" must
-- not mean "read everyone's files". The seeded grants are GLOBAL only.
create policy crm_imports_select on public.crm_imports
  for select to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import'))
         and ((select authz.scope_for('crm.import')) = 'GLOBAL'
              or created_by = (select authz.person_id())));
create policy crm_imports_insert on public.crm_imports
  for insert to app_user
  with check (org_id = (select authz.org_id()) and (select authz.is_active())
              and (select authz.has('crm.import'))
              and created_by = (select authz.person_id()));
create policy crm_imports_update on public.crm_imports
  for update to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import'))
         and ((select authz.scope_for('crm.import')) = 'GLOBAL'
              or created_by = (select authz.person_id())))
  with check (org_id = (select authz.org_id()));

create policy crm_import_rows_select on public.crm_import_rows
  for select to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import'))
         and ((select authz.scope_for('crm.import')) = 'GLOBAL'
              or exists (select 1 from public.crm_imports i
                          where i.id = crm_import_rows.import_id
                            and i.created_by = (select authz.person_id()))));
create policy crm_import_rows_insert on public.crm_import_rows
  for insert to app_user
  with check (org_id = (select authz.org_id()) and (select authz.is_active())
              and (select authz.has('crm.import')));
create policy crm_import_rows_update on public.crm_import_rows
  for update to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import'))
         and ((select authz.scope_for('crm.import')) = 'GLOBAL'
              or exists (select 1 from public.crm_imports i
                          where i.id = crm_import_rows.import_id
                            and i.created_by = (select authz.person_id()))))
  with check (org_id = (select authz.org_id()));

-- roles.sql's default privileges give app_user select, insert and update; nobody else
-- needs anything, and nobody deletes.
revoke delete, truncate on public.crm_imports, public.crm_import_rows from app_user;
revoke all on public.crm_imports, public.crm_import_rows from app_admin, app_worker, app_auth;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 6 — crm_import_execute_as_job(job, worker_id)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The worker's only way to learn who a crm_import job runs as. The 0070 rules for
-- workflow_execute_as_job(), plus: the job's payload names an import of the job's
-- organization, queued or running under THIS job, created by the person who enqueued it.
-- The worker then runs the commit as that person through withAuthorizedDb(), where RLS and
-- the CRM's triggers re-check every write.

create function public.crm_import_execute_as_job(p_job_id uuid, p_worker_id text)
returns table (org_id uuid, person_id uuid, import_id uuid, import_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_type text;
  v_job_status text;
  v_job_org uuid;
  v_job_payload jsonb;
  v_job_claimed_by text;
  v_principal uuid;
  v_import uuid;
  v_import_creator uuid;
  v_import_job uuid;
  v_import_status text;
begin
  if not (select authz.is_worker()) then
    raise exception 'crm_import_execute_as_job is worker-plane only' using errcode = '42501';
  end if;

  select j.type, j.status, j.org_id, j.payload, j.enqueued_by, j.claimed_by
    into v_job_type, v_job_status, v_job_org, v_job_payload, v_principal, v_job_claimed_by
  from public.jobs j
  where j.id = p_job_id
  for update;

  if not found then
    raise exception 'crm_import_execute_as_job: job % not found', p_job_id
      using errcode = '22023';
  end if;
  if v_job_type <> 'crm_import' then
    raise exception 'crm_import_execute_as_job: job % has type %, not crm_import',
      p_job_id, v_job_type
      using errcode = '22023';
  end if;
  if v_job_status <> 'running' then
    raise exception 'crm_import_execute_as_job: job % is %, not running', p_job_id, v_job_status
      using errcode = '22023';
  end if;
  if p_worker_id is null or v_job_claimed_by is distinct from p_worker_id then
    raise exception 'crm_import_execute_as_job: job % is not held by this worker', p_job_id
      using errcode = '42501';
  end if;

  begin
    v_import := (v_job_payload ->> 'importId')::uuid;
  exception when invalid_text_representation then
    v_import := null;
  end;
  if v_import is null then
    raise exception 'crm_import_execute_as_job: job % payload has no usable importId', p_job_id
      using errcode = '22023';
  end if;

  select i.created_by, i.job_id, i.status into v_import_creator, v_import_job, v_import_status
  from public.crm_imports i
  where i.id = v_import and i.org_id = v_job_org;
  if not found then
    raise exception 'crm_import_execute_as_job: import % not found in the job''s organization',
      v_import
      using errcode = '22023';
  end if;
  -- A job row that does not verify can never succeed on retry: 22023 (non-retryable).
  if v_import_job is distinct from p_job_id then
    raise exception 'crm_import_execute_as_job: import % is not bound to job %', v_import, p_job_id
      using errcode = '22023';
  end if;
  if v_import_status = 'PREVIEWED' then
    raise exception 'crm_import_execute_as_job: import % was never confirmed', v_import
      using errcode = '22023';
  end if;
  if v_principal is null or v_principal is distinct from v_import_creator then
    raise exception 'crm_import_execute_as_job: job % was not enqueued by the importer', p_job_id
      using errcode = '22023';
  end if;

  org_id := v_job_org;
  person_id := v_principal;
  import_id := v_import;
  import_status := v_import_status;

  -- A finished or cancelled import is returned without a live-principal check: the handler
  -- ends the job quietly (a redelivered job after completion, or a cancellation).
  if v_import_status not in ('QUEUED', 'RUNNING') then
    return next;
    return;
  end if;

  perform 1
  from public.people p
  join public.engagements e
    on e.person_id = p.id
   and e.org_id = p.org_id
   and e.status = 'ACTIVE'
   and e.deleted_at is null
  join public.organizations o
    on o.id = p.org_id
   and o.status = 'ACTIVE'
   and o.deleted_at is null
  where p.id = v_principal
    and p.org_id = v_job_org
    and p.deleted_at is null
    and p.person_status = 'ACTIVE';
  if not found then
    raise exception 'crm_import_execute_as_job: no live principal % in org % for job %',
      v_principal, v_job_org, p_job_id
      using errcode = '42501';
  end if;

  return next;
end;
$$;

comment on function public.crm_import_execute_as_job(uuid, text) is
  'Worker-plane only (app_worker): the verified (org, person, import, status) of a crm_import job the '
  'calling worker holds. The person is the job''s enqueuer and the import''s creator (0081).';

revoke all on function public.crm_import_execute_as_job(uuid, text) from public;
grant execute on function public.crm_import_execute_as_job(uuid, text) to app_worker;

-- ── Recording failures from the worker plane ─────────────────────────────────────
--
-- An import must never stay QUEUED or RUNNING without a recorded outcome. The importer's own
-- commit records its completion; these two record a failure when the importer's identity can
-- no longer do it (it lost crm.import, or was deactivated) or the job has ended without a
-- result. Each writes one crm.import.failed audit entry in the same transaction: ids, file
-- name, hash and a reason code, never row values. The entry's actor is the import's creator —
-- the person whose import failed — as write_audit_log() would record them: no audit entry is
-- ever actor-less (an invariant tests/db/audit-triggers.test.ts checks database-wide). The
-- metadata says the worker plane recorded it.

create function public.crm_import_audit_failure(
  p_org uuid, p_import uuid, p_job uuid, p_reason text, p_file_name text, p_sha text,
  p_creator uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into public.audit_logs (org_id, actor_person_id, actor_email_snapshot, action,
                                 entity_type, entity_id, severity, result, metadata)
  select p_org, p.id, p.work_email, 'crm.import.failed', 'crm_import', p_import, 'MEDIUM', 'ERROR',
         jsonb_build_object('importId', p_import, 'jobId', p_job, 'reason', p_reason,
                            'fileName', p_file_name, 'fileSha256', p_sha,
                            'recordedBy', 'worker')
  from public.people p
  where p.id = p_creator and p.org_id = p_org;
  get diagnostics v_n = row_count;
  -- Fail closed: a failure is never recorded without its audit entry (the whole definer rolls
  -- back with the status change if the importer's person row cannot be found).
  if v_n <> 1 then
    raise exception 'crm_import_audit_failure: no audit entry written' using errcode = 'XX000';
  end if;
end;
$$;

revoke all on function public.crm_import_audit_failure(uuid, uuid, uuid, text, text, text, uuid)
  from public;

-- The job this worker holds failed for good: record it on the import (QUEUED/RUNNING only).
create function public.crm_import_record_job_failure(
  p_job_id uuid, p_worker_id text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_type text;
  v_job_status text;
  v_job_org uuid;
  v_job_claimed_by text;
  v_import uuid;
  v_row public.crm_imports;
begin
  if not (select authz.is_worker()) then
    raise exception 'crm_import_record_job_failure is worker-plane only' using errcode = '42501';
  end if;
  if p_reason is null or p_reason !~ '^[A-Z][A-Z_]{2,39}$' then
    raise exception 'crm_import_record_job_failure: reason must be a code' using errcode = '22023';
  end if;

  select j.type, j.status, j.org_id, j.claimed_by,
         case when j.payload ->> 'importId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (j.payload ->> 'importId')::uuid end
    into v_job_type, v_job_status, v_job_org, v_job_claimed_by, v_import
  from public.jobs j
  where j.id = p_job_id
  for update;
  if not found or v_job_type <> 'crm_import' or v_job_status <> 'running'
     or p_worker_id is null or v_job_claimed_by is distinct from p_worker_id then
    raise exception 'crm_import_record_job_failure: job % is not a crm_import job held by this worker',
      p_job_id
      using errcode = '42501';
  end if;

  select * into v_row from public.crm_imports i
  where i.id = v_import and i.org_id = v_job_org and i.job_id = p_job_id
  for update;
  if not found or v_row.status not in ('QUEUED', 'RUNNING') then
    return false;
  end if;

  update public.crm_imports set status = 'FAILED', failure_reason = p_reason
  where id = v_row.id;
  perform public.crm_import_audit_failure(v_row.org_id, v_row.id, p_job_id, p_reason,
                                          v_row.file_name, v_row.file_sha256, v_row.created_by);
  return true;
end;
$$;

comment on function public.crm_import_record_job_failure(uuid, text, text) is
  'Worker-plane only (app_worker): marks the QUEUED/RUNNING import bound to the crm_import job '
  'this worker holds FAILED with a reason code, and audits it (0081).';

revoke all on function public.crm_import_record_job_failure(uuid, text, text) from public;
grant execute on function public.crm_import_record_job_failure(uuid, text, text) to app_worker;

-- Maintenance: imports whose job ended or was deleted without an outcome are FAILED.
create function public.crm_import_fail_abandoned(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.crm_imports;
  v_n integer := 0;
begin
  if not (select authz.is_worker()) then
    raise exception 'crm_import_fail_abandoned is worker-plane only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_limit must be between 1 and 10000, got %', p_limit using errcode = '22023';
  end if;

  -- 'failed' is not terminal for a job (a retry is due), and a running job is in progress:
  -- only a job that is gone, succeeded, dead-lettered or cancelled leaves an import abandoned.
  for v_row in
    select i.* from public.crm_imports i
    where i.status in ('QUEUED', 'RUNNING')
      and not exists (select 1 from public.jobs j
                       where j.id = i.job_id and j.org_id = i.org_id
                         and j.status in ('pending', 'claimed', 'running', 'failed'))
    order by i.created_at
    limit p_limit
    for update of i skip locked
  loop
    update public.crm_imports set status = 'FAILED', failure_reason = 'JOB_ENDED'
    where id = v_row.id;
    perform public.crm_import_audit_failure(v_row.org_id, v_row.id, v_row.job_id, 'JOB_ENDED',
                                            v_row.file_name, v_row.file_sha256, v_row.created_by);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

comment on function public.crm_import_fail_abandoned(integer) is
  'Worker-plane only (app_worker), run by DB maintenance: an import QUEUED or RUNNING whose job '
  'is gone or ended without an outcome is marked FAILED (JOB_ENDED) and audited (0081).';

revoke all on function public.crm_import_fail_abandoned(integer) from public;
grant execute on function public.crm_import_fail_abandoned(integer) to app_worker;

-- ── A crm_import job is not cancelled by hand ────────────────────────────────────
--
-- jobs.cancel is an operations permission (PROJECT_MANAGER holds it at DEPARTMENT); cancelling a
-- RUNNING import job would stop someone else's import half-way, its committed batches kept. An
-- import is cancelled through its own route, by its importer, before it runs. The worker plane
-- (no person) is unaffected; nothing else changes for other job types.

create function public.crm_import_jobs_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled'
     and (select authz.person_id()) is not null then
    raise exception 'a crm_import job is cancelled through its import, not directly'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.crm_import_jobs_guard() is
  'BEFORE UPDATE on jobs, crm_import rows only (0081): a person cannot cancel a crm_import job.';

revoke all on function public.crm_import_jobs_guard() from public;

create trigger crm_import_jobs_guard
  before update on public.jobs
  for each row when (old.type = 'crm_import')
  execute function public.crm_import_jobs_guard();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 7 — seed_system_roles() CREATE OR REPLACE (0057 body + the crm.import grants)
-- ═════════════════════════════════════════════════════════════════════════════════

create or replace function public.seed_system_roles(p_org_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.roles (org_id, key, name, description, is_system, is_protected)
  values
    -- is_protected is true for SUPER_ADMIN alone, and it is not a judgement about
    -- seniority: it is the mechanical consequence of blueprint 6.2, which defines a
    -- protected role as one carrying roles.manage or permissions.manage. The matrix
    -- grants those to SUPER_ADMIN and to nobody else.
    (p_org_id, 'SUPER_ADMIN',     'Super Administrator', 'Full access, including role and permission management and security settings', true, true),
    (p_org_id, 'ADMIN',           'Administrator',       'Operational administration. Deliberately NOT a superset of HR: no identity documents, no compensation', true, false),
    (p_org_id, 'HR_ADMIN',        'HR Administrator',    'Full people, HR and hiring administration. No sales pipeline and no audit log', true, false),
    (p_org_id, 'HR_MANAGER',      'HR Manager',          'People and HR administration within their own departments', true, false),
    (p_org_id, 'MANAGER',         'Manager',             'Line management. No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'SALES_MANAGER',   'Sales Manager',       'Sales and delivery leadership across their departments', true, false),
    (p_org_id, 'SALES',           'Sales',               'Own leads, own clients, own tasks', true, false),
    (p_org_id, 'PROJECT_MANAGER', 'Project Manager',     'Projects, tasks and delivery within their departments', true, false),
    (p_org_id, 'DEVELOPER',       'Developer',           'The projects they are assigned to, and their own profile', true, false),
    (p_org_id, 'VIBECODER',       'Vibecoder',           'The projects they are assigned to, and nothing wider', true, false),
    (p_org_id, 'FINANCE',         'Finance',             'Commercial and compensation data. A separate boundary from HR, not a subset of it', true, false),
    (p_org_id, 'MARKETING',       'Marketing',           'No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'INTERN',          'Intern',              'Self and assigned projects only. The legal classification lives on the engagement, never here', true, false),
    (p_org_id, 'EMPLOYEE',        'Employee',            'The baseline every active engagement receives. Self-service only', true, false)
  on conflict do nothing;

  -- SUPER_ADMIN: the whole catalogue at GLOBAL, minus the one permission V1 does not
  -- implement.
  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, 'GLOBAL'::public.access_scope
  from public.roles r
  cross join public.permissions p
  where r.org_id = p_org_id
    and r.key = 'SUPER_ADMIN'
    and p.key <> 'users.impersonate'
  on conflict do nothing;

  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, m.scope::public.access_scope
  from (values
    -- ADMIN
    ('ADMIN','users.view','GLOBAL'),('ADMIN','users.create','GLOBAL'),
    ('ADMIN','users.suspend','GLOBAL'),('ADMIN','sessions.revoke','GLOBAL'),
    ('ADMIN','departments.manage','GLOBAL'),
    ('ADMIN','people.view','GLOBAL'),('ADMIN','people.edit','GLOBAL'),('ADMIN','people.export','GLOBAL'),
    ('ADMIN','engagements.transition','GLOBAL'),
    ('ADMIN','candidates.view','GLOBAL'),('ADMIN','offers.approve','GLOBAL'),
    ('ADMIN','onboarding.manage','GLOBAL'),('ADMIN','offboarding.initiate','GLOBAL'),
    ('ADMIN','projects.view','GLOBAL'),('ADMIN','projects.create','GLOBAL'),
    ('ADMIN','projects.edit','GLOBAL'),('ADMIN','projects.manage_members','GLOBAL'),
    ('ADMIN','tasks.view','GLOBAL'),('ADMIN','tasks.edit','GLOBAL'),('ADMIN','tasks.assign','GLOBAL'),
    ('ADMIN','documents.view','GLOBAL'),('ADMIN','documents.upload','GLOBAL'),('ADMIN','documents.download','GLOBAL'),
    ('ADMIN','policies.manage','GLOBAL'),('ADMIN','policies.acknowledge','SELF'),
    ('ADMIN','policies.view_compliance','GLOBAL'),
    ('ADMIN','reports.view','GLOBAL'),('ADMIN','audit_logs.view','GLOBAL'),('ADMIN','settings.manage','GLOBAL'),
    -- ADMIN (Phase 5): the full workflow sextet at GLOBAL. workflows.delete
    -- is granted to ADMIN alone outside the SUPER_ADMIN cross join.
    ('ADMIN','workflows.view','GLOBAL'),('ADMIN','workflows.create','GLOBAL'),
    ('ADMIN','workflows.edit','GLOBAL'),('ADMIN','workflows.delete','GLOBAL'),
    ('ADMIN','workflows.activate','GLOBAL'),('ADMIN','workflows.execute','GLOBAL'),
    -- ADMIN (Phase 6): the full jobs quintet at GLOBAL. jobs.delete is
    -- granted to ADMIN alone outside the SUPER_ADMIN cross join — the
    -- 0008 projects.delete / 0044 workflows.delete precedent.
    ('ADMIN','jobs.view','GLOBAL'),('ADMIN','jobs.create','GLOBAL'),
    ('ADMIN','jobs.retry','GLOBAL'),('ADMIN','jobs.cancel','GLOBAL'),
    ('ADMIN','jobs.delete','GLOBAL'),

    -- HR_ADMIN
    ('HR_ADMIN','users.view','GLOBAL'),('HR_ADMIN','users.create','GLOBAL'),
    ('HR_ADMIN','users.suspend','DEPARTMENT'),('HR_ADMIN','sessions.revoke','DEPARTMENT'),
    ('HR_ADMIN','departments.manage','GLOBAL'),
    ('HR_ADMIN','people.view','GLOBAL'),('HR_ADMIN','people.edit','GLOBAL'),('HR_ADMIN','people.export','GLOBAL'),
    ('HR_ADMIN','hr.sensitive.view','GLOBAL'),('HR_ADMIN','compensation.view','GLOBAL'),
    ('HR_ADMIN','engagements.transition','GLOBAL'),
    ('HR_ADMIN','candidates.view','GLOBAL'),('HR_ADMIN','scorecards.view_all','GLOBAL'),
    ('HR_ADMIN','offers.approve','GLOBAL'),
    ('HR_ADMIN','onboarding.manage','GLOBAL'),('HR_ADMIN','offboarding.initiate','GLOBAL'),
    ('HR_ADMIN','documents.view','GLOBAL'),('HR_ADMIN','documents.upload','GLOBAL'),
    ('HR_ADMIN','documents.download','GLOBAL'),('HR_ADMIN','documents.verify','GLOBAL'),
    ('HR_ADMIN','policies.manage','GLOBAL'),('HR_ADMIN','policies.acknowledge','SELF'),
    ('HR_ADMIN','policies.view_compliance','GLOBAL'),('HR_ADMIN','reports.view','GLOBAL'),

    -- HR_MANAGER
    ('HR_MANAGER','users.view','DEPARTMENT'),
    ('HR_MANAGER','people.view','DEPARTMENT'),('HR_MANAGER','people.edit','DEPARTMENT'),
    ('HR_MANAGER','hr.sensitive.view','DEPARTMENT'),
    ('HR_MANAGER','engagements.transition','DEPARTMENT'),
    ('HR_MANAGER','candidates.view','GLOBAL'),('HR_MANAGER','scorecards.view_all','GLOBAL'),
    ('HR_MANAGER','onboarding.manage','DEPARTMENT'),('HR_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('HR_MANAGER','documents.view','DEPARTMENT'),('HR_MANAGER','documents.upload','DEPARTMENT'),
    ('HR_MANAGER','documents.download','DEPARTMENT'),('HR_MANAGER','documents.verify','DEPARTMENT'),
    ('HR_MANAGER','policies.acknowledge','SELF'),('HR_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('HR_MANAGER','reports.view','DEPARTMENT'),

    -- SALES_MANAGER
    ('SALES_MANAGER','people.view','DEPARTMENT'),
    ('SALES_MANAGER','candidates.view','DEPARTMENT'),('SALES_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('SALES_MANAGER','onboarding.manage','DEPARTMENT'),('SALES_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('SALES_MANAGER','projects.view','DEPARTMENT'),('SALES_MANAGER','projects.create','DEPARTMENT'),
    ('SALES_MANAGER','projects.edit','DEPARTMENT'),('SALES_MANAGER','projects.manage_members','DEPARTMENT'),
    ('SALES_MANAGER','tasks.view','DEPARTMENT'),('SALES_MANAGER','tasks.edit','DEPARTMENT'),
    ('SALES_MANAGER','tasks.assign','DEPARTMENT'),
    ('SALES_MANAGER','documents.view','DEPARTMENT'),('SALES_MANAGER','documents.upload','DEPARTMENT'),
    ('SALES_MANAGER','documents.download','DEPARTMENT'),
    ('SALES_MANAGER','policies.acknowledge','SELF'),('SALES_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('SALES_MANAGER','reports.view','DEPARTMENT'),

    -- SALES. tasks.view / tasks.edit are the matrix S+P cells; see the note above.
    ('SALES','people.view','SELF'),('SALES','people.edit','SELF'),
    ('SALES','projects.view','SELF'),
    ('SALES','tasks.view','SELF'),('SALES','tasks.edit','SELF'),
    ('SALES','documents.view','SELF'),('SALES','documents.upload','SELF'),('SALES','documents.download','SELF'),
    ('SALES','policies.acknowledge','SELF'),('SALES','reports.view','SELF'),

    -- PROJECT_MANAGER
    ('PROJECT_MANAGER','people.view','DEPARTMENT'),
    ('PROJECT_MANAGER','candidates.view','DEPARTMENT'),('PROJECT_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('PROJECT_MANAGER','onboarding.manage','DEPARTMENT'),('PROJECT_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('PROJECT_MANAGER','clients.view','DEPARTMENT'),('PROJECT_MANAGER','clients.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.view','DEPARTMENT'),('PROJECT_MANAGER','projects.create','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.edit','DEPARTMENT'),('PROJECT_MANAGER','projects.manage_members','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.view','DEPARTMENT'),('PROJECT_MANAGER','tasks.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.assign','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.view','DEPARTMENT'),('PROJECT_MANAGER','documents.upload','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.download','DEPARTMENT'),
    ('PROJECT_MANAGER','policies.acknowledge','SELF'),('PROJECT_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('PROJECT_MANAGER','reports.view','DEPARTMENT'),
    -- PROJECT_MANAGER (Phase 5): build and run automations inside their
    -- departments. No workflows.delete — deletion stays on the admin path.
    ('PROJECT_MANAGER','workflows.view','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.create','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.activate','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.execute','DEPARTMENT'),
    -- PROJECT_MANAGER (Phase 6): operate the job queue inside their
    -- departments. No jobs.delete — purges stay on the admin path.
    ('PROJECT_MANAGER','jobs.view','DEPARTMENT'),
    ('PROJECT_MANAGER','jobs.create','DEPARTMENT'),
    ('PROJECT_MANAGER','jobs.retry','DEPARTMENT'),
    ('PROJECT_MANAGER','jobs.cancel','DEPARTMENT'),

    -- DEVELOPER
    ('DEVELOPER','people.view','SELF'),('DEVELOPER','people.edit','SELF'),
    ('DEVELOPER','clients.view','PROJECT'),
    ('DEVELOPER','projects.view','PROJECT'),('DEVELOPER','projects.edit','PROJECT'),
    ('DEVELOPER','tasks.view','PROJECT'),('DEVELOPER','tasks.edit','PROJECT'),('DEVELOPER','tasks.assign','PROJECT'),
    ('DEVELOPER','documents.view','SELF'),('DEVELOPER','documents.upload','SELF'),('DEVELOPER','documents.download','SELF'),
    ('DEVELOPER','policies.acknowledge','SELF'),('DEVELOPER','reports.view','PROJECT'),

    -- VIBECODER
    ('VIBECODER','people.view','SELF'),('VIBECODER','people.edit','SELF'),
    ('VIBECODER','clients.view','PROJECT'),('VIBECODER','projects.view','PROJECT'),
    ('VIBECODER','tasks.view','PROJECT'),('VIBECODER','tasks.edit','PROJECT'),
    ('VIBECODER','documents.view','SELF'),('VIBECODER','documents.upload','SELF'),('VIBECODER','documents.download','SELF'),
    ('VIBECODER','policies.acknowledge','SELF'),

    -- INTERN
    ('INTERN','people.view','SELF'),('INTERN','people.edit','SELF'),
    ('INTERN','hr.sensitive.view','SELF'),
    ('INTERN','clients.view','PROJECT'),('INTERN','projects.view','PROJECT'),
    ('INTERN','tasks.view','SELF'),('INTERN','tasks.edit','SELF'),
    ('INTERN','documents.view','SELF'),('INTERN','documents.upload','SELF'),('INTERN','documents.download','SELF'),
    ('INTERN','policies.acknowledge','SELF'),

    -- FINANCE
    ('FINANCE','people.view','SELF'),('FINANCE','people.edit','SELF'),
    ('FINANCE','compensation.view','GLOBAL'),
    ('FINANCE','clients.view','GLOBAL'),('FINANCE','projects.view','GLOBAL'),
    ('FINANCE','documents.view','GLOBAL'),('FINANCE','documents.upload','GLOBAL'),('FINANCE','documents.download','GLOBAL'),
    ('FINANCE','policies.acknowledge','SELF'),('FINANCE','reports.view','GLOBAL'),

    -- EMPLOYEE
    ('EMPLOYEE','people.view','SELF'),('EMPLOYEE','people.edit','SELF'),
    ('EMPLOYEE','hr.sensitive.view','SELF'),('EMPLOYEE','compensation.view','SELF'),
    ('EMPLOYEE','tasks.view','SELF'),('EMPLOYEE','tasks.edit','SELF'),
    ('EMPLOYEE','documents.view','SELF'),('EMPLOYEE','documents.upload','SELF'),('EMPLOYEE','documents.download','SELF'),
    ('EMPLOYEE','policies.acknowledge','SELF'),

    -- ── Phase 2 CRM Core (migration 0033): the crm module replaces the legacy
    -- sales vocabulary. ADMIN/SALES_MANAGER/SALES get the new keys at the same
    -- scopes the matrix already uses for leads.* / clients.*.
    -- ADMIN
    ('ADMIN','companies.view','GLOBAL'),('ADMIN','companies.create','GLOBAL'),
    ('ADMIN','companies.edit','GLOBAL'),('ADMIN','companies.delete','GLOBAL'),
    ('ADMIN','contacts.view','GLOBAL'),('ADMIN','contacts.create','GLOBAL'),
    ('ADMIN','contacts.edit','GLOBAL'),('ADMIN','contacts.delete','GLOBAL'),
    ('ADMIN','contacts.export','GLOBAL'),
    ('ADMIN','deals.view','GLOBAL'),('ADMIN','deals.create','GLOBAL'),
    ('ADMIN','deals.edit','GLOBAL'),('ADMIN','deals.delete','GLOBAL'),
    ('ADMIN','deals.export','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','companies.view','DEPARTMENT'),('SALES_MANAGER','companies.create','DEPARTMENT'),
    ('SALES_MANAGER','companies.edit','DEPARTMENT'),('SALES_MANAGER','companies.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.view','DEPARTMENT'),('SALES_MANAGER','contacts.create','DEPARTMENT'),
    ('SALES_MANAGER','contacts.edit','DEPARTMENT'),('SALES_MANAGER','contacts.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.export','DEPARTMENT'),
    ('SALES_MANAGER','deals.view','DEPARTMENT'),('SALES_MANAGER','deals.create','DEPARTMENT'),
    ('SALES_MANAGER','deals.edit','DEPARTMENT'),('SALES_MANAGER','deals.delete','DEPARTMENT'),
    ('SALES_MANAGER','deals.export','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column:
    -- no delete, no export, no assign)
    ('SALES','companies.view','SELF'),('SALES','companies.create','SELF'),
    ('SALES','companies.edit','SELF'),
    ('SALES','contacts.view','SELF'),('SALES','contacts.create','SELF'),
    ('SALES','contacts.edit','SELF'),
    ('SALES','deals.view','SELF'),('SALES','deals.create','SELF'),
    ('SALES','deals.edit','SELF'),
    -- ── Track B: activities + relationships (migration 0034). The catalogue keys are
    -- seeded above; the matrix below grants them at the same scopes as the CRM
    -- Core rows: ADMIN at GLOBAL, SALES_MANAGER at DEPARTMENT, SALES at SELF on
    -- view/create/edit only (mirroring the leads.* SELF column: no delete).
    -- ADMIN
    ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
    ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
    ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
    ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
    ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
    ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
    ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column)
    ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
    ('SALES','activities.edit','SELF'),
    ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
    ('SALES','relationships.edit','SELF'),
    -- ── Phase 3 sales pipeline (migration 0037): pipeline configuration is an
    -- admin surface. ADMIN holds the five keys at GLOBAL; SUPER_ADMIN gets them
    -- through the whole-catalogue cross join above. No other role is granted
    -- pipeline keys.
    -- ADMIN
    ('ADMIN','pipelines.view','GLOBAL'),('ADMIN','pipelines.create','GLOBAL'),
    ('ADMIN','pipelines.edit','GLOBAL'),('ADMIN','pipelines.delete','GLOBAL'),
    ('ADMIN','pipeline_stages.manage','GLOBAL'),
    -- ── Phase 4 work management (migration 0042): the work tables are an
    -- operational surface, not an admin surface like pipelines. MANAGER gains
    -- the project and task keys at DEPARTMENT (line management — the 0008
    -- matrix seeded MANAGER no permissions at all); ADMIN gains
    -- projects.delete and tasks.delete at GLOBAL; tasks.create rides with
    -- tasks.view at each role's existing scope, so no role gains task
    -- visibility it did not already hold. tasks.delete is deliberately NOT
    -- seeded to non-admin roles: creators delete through the work_tasks
    -- DELETE RLS policy, not through a seed grant. tasks.comment stays
    -- ungranted (fail closed) until the comments feature lands.
    -- MANAGER
    ('MANAGER','projects.view','DEPARTMENT'),('MANAGER','projects.create','DEPARTMENT'),
    ('MANAGER','projects.edit','DEPARTMENT'),
    ('MANAGER','tasks.view','DEPARTMENT'),('MANAGER','tasks.create','DEPARTMENT'),
    ('MANAGER','tasks.edit','DEPARTMENT'),
    ('MANAGER','policies.acknowledge','SELF'),
    -- ADMIN
    ('ADMIN','projects.delete','GLOBAL'),
    ('ADMIN','tasks.create','GLOBAL'),('ADMIN','tasks.delete','GLOBAL'),
    -- tasks.create rides alongside tasks.view at each role's existing scope
    ('SALES_MANAGER','tasks.create','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.create','DEPARTMENT'),
    ('DEVELOPER','tasks.create','PROJECT'),
    ('VIBECODER','tasks.create','PROJECT'),
    ('INTERN','tasks.create','SELF'),
    ('SALES','tasks.create','SELF'),
    ('EMPLOYEE','tasks.create','SELF'),
    -- Phase 8 (0052): notification permissions. notifications.view lets every
    -- employee role read its own notifications (SUPER_ADMIN/ADMIN at GLOBAL,
    -- everyone else SELF); notifications.preferences.manage is the universal
    -- self-service preference permission (SELF for every role — SUPER_ADMIN
    -- keeps the GLOBAL it already holds from the whole-catalogue cross join
    -- above via on-conflict-do-nothing, mirroring the policies.acknowledge
    -- precedent); notifications.send is the admin-broadcast capability
    -- (GLOBAL for SUPER_ADMIN/ADMIN only).
    ('SUPER_ADMIN','notifications.view','GLOBAL'),
    ('ADMIN','notifications.view','GLOBAL'),
    ('HR_ADMIN','notifications.view','SELF'),
    ('HR_MANAGER','notifications.view','SELF'),
    ('MANAGER','notifications.view','SELF'),
    ('SALES_MANAGER','notifications.view','SELF'),
    ('SALES','notifications.view','SELF'),
    ('PROJECT_MANAGER','notifications.view','SELF'),
    ('DEVELOPER','notifications.view','SELF'),
    ('VIBECODER','notifications.view','SELF'),
    ('INTERN','notifications.view','SELF'),
    ('FINANCE','notifications.view','SELF'),
    ('EMPLOYEE','notifications.view','SELF'),
    ('SUPER_ADMIN','notifications.preferences.manage','SELF'),
    ('ADMIN','notifications.preferences.manage','SELF'),
    ('HR_ADMIN','notifications.preferences.manage','SELF'),
    ('HR_MANAGER','notifications.preferences.manage','SELF'),
    ('MANAGER','notifications.preferences.manage','SELF'),
    ('SALES_MANAGER','notifications.preferences.manage','SELF'),
    ('SALES','notifications.preferences.manage','SELF'),
    ('PROJECT_MANAGER','notifications.preferences.manage','SELF'),
    ('DEVELOPER','notifications.preferences.manage','SELF'),
    ('VIBECODER','notifications.preferences.manage','SELF'),
    ('INTERN','notifications.preferences.manage','SELF'),
    ('FINANCE','notifications.preferences.manage','SELF'),
    ('EMPLOYEE','notifications.preferences.manage','SELF'),
    ('SUPER_ADMIN','notifications.send','GLOBAL'),
    ('ADMIN','notifications.send','GLOBAL'),
    -- Phase 9 (0055): AI Foundation permissions (contract §2.2). ai.use goes
    -- to every role holding CRM or work record access, at the scope of that
    -- role's widest record-view grant; it never widens record access — the
    -- entity permission + RLS decide every record. HR_ADMIN / HR_MANAGER hold
    -- no CRM/work record access and MARKETING holds nothing, so none of them
    -- are granted. ai.usage.view / ai.usage.manage are SUPER_ADMIN + ADMIN at
    -- GLOBAL only (the notifications.send precedent); SUPER_ADMIN's rows also
    -- arrive via the whole-catalogue cross join above.
    ('SUPER_ADMIN','ai.use','GLOBAL'),
    ('ADMIN','ai.use','GLOBAL'),
    ('SALES_MANAGER','ai.use','DEPARTMENT'),
    ('SALES','ai.use','SELF'),
    ('PROJECT_MANAGER','ai.use','DEPARTMENT'),
    ('MANAGER','ai.use','DEPARTMENT'),
    ('DEVELOPER','ai.use','PROJECT'),
    ('VIBECODER','ai.use','PROJECT'),
    ('INTERN','ai.use','SELF'),
    ('EMPLOYEE','ai.use','SELF'),
    ('FINANCE','ai.use','SELF'),
    ('SUPER_ADMIN','ai.usage.view','GLOBAL'),
    ('ADMIN','ai.usage.view','GLOBAL'),
    ('SUPER_ADMIN','ai.usage.manage','GLOBAL'),
    ('ADMIN','ai.usage.manage','GLOBAL'),
    -- Phase 10 (0057): Integrations Platform permissions (contract §4.2).
    -- Connections hold org-wide credentials, so — unlike ai.use — there is
    -- no broad integrations.use grant: view and manage are SUPER_ADMIN +
    -- ADMIN at GLOBAL only (the ai.usage.* / notifications.send admin
    -- precedent). SUPER_ADMIN's rows also arrive via the whole-catalogue
    -- cross join above.
    ('SUPER_ADMIN','integrations.view','GLOBAL'),
    ('ADMIN','integrations.view','GLOBAL'),
    ('SUPER_ADMIN','integrations.manage','GLOBAL'),
    ('ADMIN','integrations.manage','GLOBAL'),
    -- Sales Sheet import (0081, BP-06): SUPER_ADMIN and ADMIN at GLOBAL only (AC-S4,
    -- proposed; founder Q8). SUPER_ADMIN's row also arrives via the cross join above.
    ('SUPER_ADMIN','crm.import','GLOBAL'),
    ('ADMIN','crm.import','GLOBAL')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 8 — backfill: existing organizations (the 0045 / 0057 defensive pattern)
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions disable trigger role_permissions_enforce_protection;
  end if;
end
$$;

--> statement-breakpoint

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','crm.import','GLOBAL'),
  ('ADMIN','crm.import','GLOBAL')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

--> statement-breakpoint

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions enable trigger role_permissions_enforce_protection;
  end if;
end
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 9 — verification
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_missing text;
  v_extra text;
begin
  if not exists (select 1 from public.permissions
                 where key = 'crm.import' and resource = 'crm' and action = 'import'
                   and module = 'crm' and is_sensitive) then
    raise exception '0081 verification: crm.import permission missing or drifted';
  end if;

  select string_agg(distinct o.slug || '/' || m.role_key, ', ') into v_missing
  from public.organizations o
  cross join (values ('SUPER_ADMIN'), ('ADMIN')) as m(role_key)
  where not exists (
    select 1
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where r.org_id = o.id and r.key = m.role_key and p.key = 'crm.import'
      and rp.scope = 'GLOBAL'
  )
  and exists (select 1 from public.roles r where r.org_id = o.id and r.key = m.role_key);

  select string_agg(distinct r.key, ', ') into v_extra
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id
  where p.key = 'crm.import' and r.key not in ('SUPER_ADMIN', 'ADMIN');

  if v_missing is not null or v_extra is not null then
    raise exception '0081 verification: crm.import grants wrong (missing: %; unexpected: %)',
      v_missing, v_extra;
  end if;
end;
$$;
