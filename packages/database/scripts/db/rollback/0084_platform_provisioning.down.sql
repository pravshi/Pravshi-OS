-- Rollback for 0084_platform_provisioning — restores the 0083 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0084's row from the history.
--
-- It refuses unless the database is exactly at 0084, and while any organization has been
-- provisioned or suspended through the platform: their provisioning records and setup
-- credentials would be lost. The tables involved are locked first, so nothing can be written
-- between the check and the change.
--
-- What this re-opens: the platform can no longer provision, suspend or reactivate
-- organizations, and a provisioned organization's first administrator could no longer complete
-- setup (there are none: see above).

begin;

set local lock_timeout = '5s';

lock table platform.provisioning_requests, platform.org_admin_setup, public.organizations
  in access exclusive mode;

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 84 then
    raise exception '0084 rollback refused: the database is not at 0084 (roll back later migrations first)';
  end if;
  if exists (select 1 from platform.provisioning_requests)
     or exists (select 1 from platform.org_admin_setup)
     or exists (select 1 from public.organizations where suspended_at is not null or suspended_by is not null) then
    raise exception '0084 rollback refused: organizations were provisioned or suspended through the platform';
  end if;
end;
$$;

drop function platform.list_organizations();
drop function platform.list_organization_types();
drop function platform.provision_organization(text, text, text, text, text, text, text, bytea, uuid);
drop function platform.reissue_org_admin_setup(uuid, bytea, uuid);
drop function platform.org_admin_setup_token_is_valid(bytea);
drop function platform.complete_org_admin_setup(bytea, text);
drop function platform.set_organization_status(uuid, text, text, uuid);

drop table platform.org_admin_setup;
drop table platform.provisioning_requests;

alter table public.organizations
  drop constraint organizations_suspension_reason_valid,
  drop constraint organizations_suspension_only_when_suspended,
  drop column suspension_reason,
  drop column suspended_by,
  drop column suspended_at;

commit;
