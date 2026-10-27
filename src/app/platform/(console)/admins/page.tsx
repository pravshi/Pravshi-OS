import { notFound } from 'next/navigation';
import { requirePlatformPage } from '@/lib/platform/page';
import { AdminsClient } from './admins-client';

export const dynamic = 'force-dynamic';

/** /platform/admins — platform administrators: list, invite, revoke (platform.admins.manage). */
export default async function PlatformAdminsPage() {
  const ctx = await requirePlatformPage();
  if (!ctx.me) return null;
  if (!ctx.me.permissions.includes('platform.admins.manage')) notFound();
  return <AdminsClient selfId={ctx.me.adminId} held={ctx.me.permissions} />;
}
