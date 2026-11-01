-- PRAVSHI OS — Phase 1 Task 1.6a: the internship extension of an engagement.
--
-- Scope boundary: this describes an internship that ALREADY EXISTS as an engagement. It
-- is not the recruitment system. Applications, screening, interviews, selection and
-- offers concern a person who may never be engaged at all, and belong to Phase 6.
--
-- Blueprint section 10: "Interns use the same people + engagements spine, with
-- engagement_type = 'INTERN' plus an internships extension row carrying mentor, expected
-- end date, review dates and outcome."

-- Blueprint section 10 ends the intern lifecycle at COMPLETED / CONVERTED / TERMINATED.
-- Kept separate from exit_type, which also carries RESIGNED and answers a different
-- question — how the engagement ended, rather than how the internship concluded.
create type public.internship_outcome as enum ('COMPLETED', 'CONVERTED', 'TERMINATED');

-- (id, engagement_type) target, so a child can pin the type declaratively.
alter table public.engagements
  add constraint engagements_id_type_unique unique (id, engagement_type);

create table public.internships (
  -- The engagement IS the key. One internship per internship engagement, and an
  -- internship cannot exist without one.
  engagement_id uuid primary key,
  org_id uuid not null references public.organizations (id),

  -- Carried solely so the composite key below can pin it. CHECKed to INTERN and matched
  -- to the engagement by foreign key, so it cannot hold a value that disagrees.
  engagement_type public.engagement_type not null default 'INTERN',

  mentor_person_id uuid,

  program_name text,
  stipend_amount numeric(14, 2),
  currency char(3),

  mid_review_date date,
  final_review_date date,

  outcome public.internship_outcome,

  -- documents arrives in Phase 5, so no foreign key yet — the same treatment
  -- people.auth_user_id has until Better Auth lands.
  certificate_document_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint internships_type_is_intern check (engagement_type = 'INTERN'),
  constraint internships_currency_format check (currency is null or currency ~ '^[A-Z]{3}$'),
  -- numeric with an explicit currency, never a float, and a stipend without a currency is
  -- an amount nobody can interpret.
  constraint internships_currency_with_amount
    check (stipend_amount is null or currency is not null),
  constraint internships_stipend_not_negative check (stipend_amount is null or stipend_amount >= 0),
  constraint internships_reviews_ordered
    check (mid_review_date is null or final_review_date is null or final_review_date >= mid_review_date)
);

-- No deleted_at. An internship is an extension of its engagement, not an independently
-- retired record: the engagement's own deleted_at and ARCHIVED status govern its life.
-- Adding one here would create a second, conflicting answer to "is this still current".

-- ── organization and type consistency ────────────────────────────────────────────
-- The same composite-key strategy as every table since Task 1.4. The type key does
-- double duty: it makes an internship row impossible on an EMPLOYEE engagement, and it
-- also blocks changing an engagement's type out from under an existing internship.

alter table public.internships
  add constraint internships_engagement_same_org
  foreign key (engagement_id, org_id) references public.engagements (id, org_id);

alter table public.internships
  add constraint internships_engagement_is_intern
  foreign key (engagement_id, engagement_type) references public.engagements (id, engagement_type);

alter table public.internships
  add constraint internships_mentor_same_org
  foreign key (mentor_person_id, org_id) references public.people (id, org_id);

create index internships_mentor_idx
  on public.internships (mentor_person_id) where mentor_person_id is not null;
create index internships_org_idx on public.internships (org_id);

create trigger internships_set_updated_at
  before update on public.internships
  for each row execute function public.set_updated_at();

comment on table public.internships is
  'Internship-specific extension of an engagement. Keyed by the engagement, restricted to '
  'engagement_type = INTERN, and carrying only what the engagement itself does not.';

-- ── RLS ──────────────────────────────────────────────────────────────────────────

alter table public.internships enable row level security;
alter table public.internships force row level security;

create policy internships_owner_all on public.internships
  for all to app_owner using (true) with check (true);

-- SELF: an intern may read their own internship record, including after the engagement
-- has ended. Mentor and HR visibility is scope_for('internships.view') in Task 1.7 — not
-- a broad organization policy standing in for it now.
create policy internships_select_self on public.internships
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and exists (
      select 1 from public.engagements e
      where e.id = public.internships.engagement_id
        and e.person_id = (select authz.person_id())
        and e.deleted_at is null
    )
  );

-- roles.sql grants select/insert/update on new public tables by default privilege. Only
-- SELECT is wanted; nothing yet decides who may assign a mentor or record an outcome.
revoke insert, update, delete on public.internships from app_user, app_admin;
