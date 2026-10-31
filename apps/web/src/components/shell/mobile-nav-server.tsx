import { heldNavPermissions } from '@/lib/authz/nav';
import { getVisibleNavItems } from './nav-items';
import { MobileNavClient } from './mobile-nav';

/**
 * Server wrapper for the mobile navigation drawer.
 * Resolves heldNavPermissions() on the server, builds the filtered nav item list,
 * and passes the serializable items to the client sheet component.
 * Hidden on md+ viewports via the client button's md:hidden.
 */
export async function MobileNav() {
  const held = await heldNavPermissions();
  const items = getVisibleNavItems(held);

  return <MobileNavClient items={items} />;
}
