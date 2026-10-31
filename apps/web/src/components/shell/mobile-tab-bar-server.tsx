import { heldNavPermissions } from '@/lib/authz/nav';
import { MobileTabBarClient, type MobileTab } from './mobile-tab-bar';

/**
 * Server wrapper for the mobile bottom tab bar.
 * Builds the permission-filtered tab list (same nav permissions as the sidebar)
 * and renders the client tab bar. Hidden on md+ viewports via the client's md:hidden.
 */
export async function MobileTabBar() {
  const held = await heldNavPermissions();

  const tabs: MobileTab[] = [{ label: 'Home', href: '/', icon: 'home' }];

  if (held.has('projects.view')) {
    tabs.push({ label: 'Work', href: '/work', icon: 'work' });
  }
  if (held.has('companies.view')) {
    tabs.push({ label: 'CRM', href: '/crm/companies', icon: 'crm' });
  }
  if (held.has('users.view') || held.has('roles.manage')) {
    tabs.push({ label: 'Admin', href: '/admin/users', icon: 'admin' });
  }

  if (tabs.length <= 1) return null;
  return <MobileTabBarClient tabs={tabs} />;
}
