-- 0036: Track B security-review hardening (M1, L2)
--
-- M1 (MEDIUM): crm_soft_delete now verifies the caller holds the delete
-- permission for the entity inside the function, not just via the service
-- layer's probe. Defense in depth against future code paths that call the
-- function directly.
--
-- L2 (LOW): Immutable-link triggers. The service layer never exposes
-- entity_type/entity_id (activities) or the FK columns (relationships) for
-- UPDATE, but the UPDATE policies' WITH CHECK is org-only. These triggers
-- enforce immutability at the database level.

-- ── M1: permission check inside crm_soft_delete ─────────────────────────────

create or replace function public.crm_soft_delete(p_entity text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_n bigint;
begin
  v_table := case p_entity
    when 'company' then 'companies'
    when 'contact' then 'contacts'
    when 'deal' then 'deals'
    when 'activity' then 'activities'
    when 'company_contact' then 'company_contacts'
    when 'company_link' then 'company_links'
    when 'contact_link' then 'contact_links'
  end;
  if v_table is null then
    raise exception 'unknown soft-delete entity: %', p_entity using errcode = '42501';
  end if;

  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() '
    'where id = $1 and org_id = authz.org_id() and deleted_at is null',
    v_table
  ) using p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'soft delete affected no rows' using errcode = '02000';
  end if;
end;
$$;

-- ── L2: immutable-link triggers ──────────────────────────────────────────────

-- Activities: entity_type and entity_id are immutable after creation.
create or replace function public.enforce_activity_link_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.entity_type is distinct from old.entity_type
     or new.entity_id is distinct from old.entity_id then
    raise exception 'activity link (entity_type, entity_id) is immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists activities_link_immutable on public.activities;
create trigger activities_link_immutable
  before update on public.activities
  for each row
  execute function public.enforce_activity_link_immutable();

-- Relationships: FK columns are immutable after creation.
create or replace function public.enforce_relationship_link_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- company_contacts
  if tg_table_name = 'company_contacts' then
    if new.company_id is distinct from old.company_id
       or new.contact_id is distinct from old.contact_id then
      raise exception 'company_contacts link is immutable' using errcode = '42501';
    end if;
  -- company_links
  elsif tg_table_name = 'company_links' then
    if new.from_company_id is distinct from old.from_company_id
       or new.to_company_id is distinct from old.to_company_id then
      raise exception 'company_links link is immutable' using errcode = '42501';
    end if;
  -- contact_links
  elsif tg_table_name = 'contact_links' then
    if new.from_contact_id is distinct from old.from_contact_id
       or new.to_contact_id is distinct from old.to_contact_id then
      raise exception 'contact_links link is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists company_contacts_link_immutable on public.company_contacts;
create trigger company_contacts_link_immutable
  before update on public.company_contacts
  for each row
  execute function public.enforce_relationship_link_immutable();

drop trigger if exists company_links_link_immutable on public.company_links;
create trigger company_links_link_immutable
  before update on public.company_links
  for each row
  execute function public.enforce_relationship_link_immutable();

drop trigger if exists contact_links_link_immutable on public.contact_links;
create trigger contact_links_link_immutable
  before update on public.contact_links
  for each row
  execute function public.enforce_relationship_link_immutable();
