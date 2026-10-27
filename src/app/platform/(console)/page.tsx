import { notFound } from 'next/navigation';
import { requirePlatformPage } from '@/lib/platform/page';
import { OrganizationsClient } from './organizations-client';

export const dynamic = 'force-dynamic';

/** /platform — the organizations: list, provision, suspend / reactivate, setup links. */
export default async function PlatformOrganizationsPage() {
  const ctx = await requirePlatformPage();
  if (ctx.unavailable || !ctx.me) return null;
  const has = (p: string) => ctx.me?.permissions.includes(p) ?? false;
  if (!has('platform.organizations.view')) notFound();
  return (
    <OrganizationsClient
      canCreate={has('platform.organizations.create')}
      canSuspend={has('platform.organizations.suspend')}
      canReactivate={has('platform.organizations.reactivate')}
      canReissue={has('platform.organizations.assign_initial_admin')}
    />
  );
}
