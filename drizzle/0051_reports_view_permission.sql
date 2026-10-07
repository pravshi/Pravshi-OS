-- Phase 7: Analytics & Dashboards — reports.view permission
-- Seeds the reports.view permission and grants it to roles.
-- Analytics dashboards require this permission (server-side enforced).

insert into public.permissions (key, resource, action, module, description, is_sensitive)
values
  ('reports.view', 'reports', 'view', 'analytics', 'View analytics dashboards and reports', false)
on conflict (key) do nothing;

--> statement-breakpoint

-- Grant reports.view to roles (following jobs.view pattern)
-- SUPER_ADMIN: GLOBAL, ADMIN: GLOBAL, PROJECT_MANAGER: DEPARTMENT
insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, v.scope::public.access_scope
from (values
  ('SUPER_ADMIN', 'reports.view', 'GLOBAL'),
  ('ADMIN', 'reports.view', 'GLOBAL'),
  ('PROJECT_MANAGER', 'reports.view', 'DEPARTMENT')
) as v(role_key, perm_key, scope)
join public.roles r on r.key = v.role_key
join public.permissions p on p.key = v.perm_key
on conflict do nothing;
