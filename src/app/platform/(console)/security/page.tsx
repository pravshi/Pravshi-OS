import { requirePlatformPage } from '@/lib/platform/page';
import { PlatformSecurityClient } from './security-client';

export const dynamic = 'force-dynamic';

/**
 * /platform/security — the administrator's second factor. Every platform action requires an
 * aal2 session and an enrolled TOTP factor (platform.current_admin()); an administrator who
 * has neither is sent here by the page gate and can do nothing else until enrolled.
 */
export default async function PlatformSecurityPage() {
  const ctx = await requirePlatformPage();
  if (ctx.unavailable) return null;
  return <PlatformSecurityClient enrolled={ctx.enrolled} />;
}
