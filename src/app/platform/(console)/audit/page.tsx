import { notFound } from 'next/navigation';
import { requirePlatformPage } from '@/lib/platform/page';
import { AuditClient } from './audit-client';

export const dynamic = 'force-dynamic';

/** /platform/audit — the platform audit trail, newest first (platform.audit.view). */
export default async function PlatformAuditPage() {
  const ctx = await requirePlatformPage();
  if (ctx.unavailable || !ctx.me) return null;
  if (!ctx.me.permissions.includes('platform.audit.view')) notFound();
  return <AuditClient />;
}
