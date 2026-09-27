-- PRAVSHI OS — Phase 1 Task 1.17: invitations and login events.
--
-- Blueprint 25: "an account can only come into being by an administrator issuing an
-- invitation, and the invitation is single-use, expiring, and stored hashed." Until now
-- that sentence had no table behind it — server.ts even admits the email transport
-- "arrives with the invitation task". This migration gives the flow its storage; the
-- service, API routes and email sending arrive in the next task.
--
-- ── WHAT THIS MIGRATION CREATES ────────────────────────────────────────────────
--
--   public.invitations        the invitation itself: who is invited, by whom, with
--                             which roles, under a single-use hashed token
--   public.invitation_roles   the roles an accepted invitation confers
--   public.login_events       pre-authentication security events (failures especially),
--                             which audit_logs cannot hold because its writer requires
--                             an identified actor — 0011 says so explicitly
--
-- ── WHAT IT DELIBERATELY DOES NOT CREATE ───────────────────────────────────────
--
--   No new permission. Issuing an invitation IS creating a user account, so the existing
--   users.create key governs it. A separate users.invite key would split one decision
--   into two places that must then be kept in agreement forever.
--
--   No write path for app_user on login_events. Like audit_logs, it is written by a
--   SECURITY DEFINER function — record_login_event(), which arrives with the service
--   task because the callers (the auth routes) arrive with it too.

-- ═════════════════════════════════════════════════════════════════════════════════
-- public.invitations
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- Human identifier, INV-2026-0001, allocated by authz.next_identity_code() inside the
  -- creating transaction. Blueprint 14: no spreadsheet-style formula IDs, ever.
  code text not null,

  -- Who is invited. citext, like every other email column: login matching must not be
  -- case-sensitive, and the accept flow looks the invitee up by this address.
  email citext not null,

  -- The single-use token, SHA-256 hex, never the plaintext. The accept route receives
  -- the plaintext token in the URL, hashes it, and compares. A database read therefore
  -- never yields a usable invitation, which is the property that makes emailing the
  -- link safe: the mailbox holds the secret, the database holds only its shadow.
  token_hash text not null,

  -- Optional link to an existing person (a candidate being hired, a person gaining a
  -- login). Null for a brand-new human; the accept flow creates the person then.
  person_id uuid,

  -- The roles the accepted invitation confers, as rows rather than an array: they are
  -- foreign keys that must resolve, not strings that might.
  invited_by uuid not null,

  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invitations_code_unique unique (org_id, code),
  -- Token hashes are unique GLOBALLY, not per org: a hash identifies the invitation on
  -- its own, and a per-org lookup would let two orgs' hashes collide silently.
  constraint invitations_token_hash_unique unique (token_hash),
  constraint invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint invitations_expires_after_creation check (expires_at > created_at),
  constraint invitations_accepted_after_creation
    check (accepted_at is null or accepted_at >= created_at),
  constraint invitations_revoked_after_creation
    check (revoked_at is null or revoked_at >= created_at),
  -- Single-use, stated as data: an invitation cannot be both accepted and revoked, and
  -- neither transition can happen twice because neither column can be written twice —
  -- the integrity trigger below freezes them after first set.
  constraint invitations_accepted_xor_revoked
    check (not (accepted_at is not null and revoked_at is not null)),
  constraint invitations_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id),
  constraint invitations_invited_by_same_org
    foreign key (invited_by, org_id) references public.people (id, org_id)
);

comment on table public.invitations is
  'Single-use, expiring, hashed invitations. The only way a login comes into being. '
  'The token plaintext exists in exactly one place: the email that carried it.';
comment on column public.invitations.token_hash is
  'SHA-256 hex of the single-use token. The plaintext is never stored, so a database '
  'read yields no usable invitation.';

create index invitations_org_idx on public.invitations (org_id);
create index invitations_email_idx on public.invitations (email);
-- The accept flow's lookup: hash the presented token, probe this index.
create unique index invitations_token_hash_idx on public.invitations (token_hash);

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

-- ── invitation integrity ───────────────────────────────────────────────────────
--
-- The 0006/0010 rule, applied a third time: the actor comes from the transaction
-- identity, never from a caller-supplied column. An invitation whose invited_by can
-- name anyone is an audit trail that can be forged.
--
-- On UPDATE the identifying columns are frozen, and accepted_at / revoked_at are
-- write-once: setting them is the single-use consumption, and un-setting one would
-- resurrect an invitation that was already spent.
create function public.enforce_invitation_integrity() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_actor := authz.person_id();
    if v_actor is not null then
      if new.invited_by is distinct from v_actor then
        raise exception
          'an invitation is attributed to the acting identity; invited_by cannot name another person'
          using errcode = '42501';
      end if;
      if authz.org_id() is distinct from new.org_id then
        raise exception 'an invitation cannot be created in another organization'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.code is distinct from old.code
     or new.email is distinct from old.email
     or new.token_hash is distinct from old.token_hash
     or new.person_id is distinct from old.person_id
     or new.invited_by is distinct from old.invited_by
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception
      'an invitation identifies one invitee, one token and one inviter; those columns are immutable'
      using errcode = '23514';
  end if;

  -- Write-once, in both directions: a spent invitation stays spent.
  if old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at then
    raise exception 'an accepted invitation cannot be un-accepted'
      using errcode = '23514';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked invitation cannot be un-revoked'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.enforce_invitation_integrity() is
  'invited_by must be the acting identity; identifying columns are immutable; '
  'accepted_at and revoked_at are write-once. Single-use is a data property, not a '
  'convention the application promises to keep.';

create trigger invitations_enforce_integrity
  before insert or update on public.invitations
  for each row execute function public.enforce_invitation_integrity();

revoke all on function public.enforce_invitation_integrity() from public;

-- ═════════════════════════════════════════════════════════════════════════════════
-- public.invitation_roles
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The roles an accepted invitation confers. Rows, not an array, so every role resolves
-- against the catalogue and a misspelt role name fails loudly at invite time rather
-- than silently at accept time.

create table public.invitation_roles (
  invitation_id uuid not null references public.invitations (id) on delete cascade,
  role_id uuid not null,
  org_id uuid not null references public.organizations (id),

  constraint invitation_roles_pkey primary key (invitation_id, role_id),
  -- The Task 1.4 composite-key strategy again: the role must belong to the same
  -- organization as the invitation, so an invite cannot smuggle in a foreign role.
  constraint invitation_roles_role_same_org
    foreign key (role_id, org_id) references public.roles (id, org_id)
);

comment on table public.invitation_roles is
  'Roles conferred when an invitation is accepted. Every role resolves against the '
  'catalogue in the invitation''s own organization.';

create index invitation_roles_role_idx on public.invitation_roles (role_id);

-- ═════════════════════════════════════════════════════════════════════════════════
-- public.login_events
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Pre-authentication security events. audit_logs cannot hold these: 0011's
-- write_audit_log() REQUIRES an identified actor, and a failed login is precisely an
-- event with no actor yet. The two tables are siblings, not competitors: audit_logs
-- records what identified people did; login_events records what happened before
-- anyone was identified.
--
-- org_id is NULLABLE, and that is the honest shape: a login attempt with a garbage
-- email resolves to no organization. Those rows are still written — they are the
-- credential-stuffing signal — but RLS cannot show them to any org's admin, because
-- there is no org to show them to. Forensics on null-org rows is direct database
-- access, documented here rather than hidden.

create table public.login_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id),

  occurred_at timestamptz not null default now(),

  -- Closed vocabulary, like entity_type in record_grants: a login event naming a type
  -- nobody queries for is a row nobody will ever find.
  event_type text not null,

  -- The attempted email, exactly as presented. May be garbage; never trusted for
  -- anything but display and forensics.
  email citext,
  auth_user_id uuid references auth.auth_users (id),

  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}',

  constraint login_events_type_format
    check (event_type in (
      'LOGIN_SUCCESS', 'LOGIN_FAILURE',
      'MFA_CHALLENGE', 'MFA_FAILURE',
      'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_SUCCESS',
      'INVITATION_ACCEPTED', 'INVITATION_REJECTED',
      'SESSION_REVOKED'
    ))
);

comment on table public.login_events is
  'Pre-authentication security events: what happened before anyone was identified. '
  'Append-only. Null org_id rows are written but RLS-invisible; forensics on them is '
  'direct database access.';
comment on column public.login_events.email is
  'The attempted email exactly as presented. May be garbage; display and forensics only.';

create index login_events_org_occurred_idx
  on public.login_events (org_id, occurred_at desc);
create index login_events_email_occurred_idx
  on public.login_events (email, occurred_at desc);

-- ── append-only, the 0011 pattern ──────────────────────────────────────────────
--
-- A login-events table that can be edited is a breach-investigation tool that can be
-- emptied. The trigger raises for every role without exception — including app_owner,
-- because the migration that installs it is already over by the time anyone could
-- want it gone.
create function public.login_events_append_only() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'login_events is append-only'
    using errcode = '42501';
  return null;
end;
$$;

comment on function public.login_events_append_only() is
  'Raises on any UPDATE or DELETE of a login event, for every role without exception.';

create trigger login_events_no_update
  before update on public.login_events
  for each row execute function public.login_events_append_only();

create trigger login_events_no_delete
  before delete on public.login_events
  for each row execute function public.login_events_append_only();

revoke all on function public.login_events_append_only() from public;

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.invitations enable row level security;
alter table public.invitations force row level security;
alter table public.invitation_roles enable row level security;
alter table public.invitation_roles force row level security;
alter table public.login_events enable row level security;
alter table public.login_events force row level security;

create policy invitations_owner_all on public.invitations
  for all to app_owner using (true) with check (true);
create policy invitation_roles_owner_all on public.invitation_roles
  for all to app_owner using (true) with check (true);
create policy login_events_owner_all on public.login_events
  for all to app_owner using (true) with check (true);

-- Invitations are visible to whoever may create users — ADMIN at GLOBAL in the seeded
-- matrix. There is deliberately no SELF visibility: an invitee has no session yet, so
-- there is no self to show them to, and the token link is their only interface.
create policy invitations_select_global on public.invitations
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.scope_for('users.create')) = 'GLOBAL'
  );

create policy invitation_roles_select_global on public.invitation_roles
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.scope_for('users.create')) = 'GLOBAL'
  );

-- INSERT is granted because the admin UI creates invitations through withAuthorizedDb():
-- Server Action -> requirePermission('users.create') -> service -> INSERT here. The
-- WITH CHECK repeats the SELECT conditions plus invited_by = self, so a caller cannot
-- mint an invitation attributed to someone else even if the trigger were bypassed.
-- There is no UPDATE or DELETE policy for app_user: acceptance and revocation go
-- through SECURITY DEFINER functions, which arrive with the service task.
create policy invitations_insert_global on public.invitations
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.scope_for('users.create')) = 'GLOBAL'
    and invited_by = (select authz.person_id())
  );

create policy invitation_roles_insert_global on public.invitation_roles
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.scope_for('users.create')) = 'GLOBAL'
  );

-- login_events is readable by the audit audience and nobody else: the same GLOBAL
-- holders as audit_logs.view. No SELF visibility, for the reason 0011 states — a
-- person must not be able to check whether their own failed logins were noticed.
-- No INSERT/UPDATE/DELETE policy for app_user at all: writes go through
-- record_login_event(), arriving with the service task.
create policy login_events_select_global on public.login_events
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.scope_for('audit_logs.view')) = 'GLOBAL'
  );

-- roles.sql grants select/insert/update by default on new public tables; the writes
-- above are the deliberate exceptions, everything else is revoked.
revoke update, delete on public.invitations from app_user, app_admin;
revoke update, delete on public.invitation_roles from app_user, app_admin;
revoke insert, update, delete on public.login_events from app_user, app_admin;
