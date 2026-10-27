import { handleSetupCompletion } from '@/lib/auth/setup-http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/organization/complete — the first administrator's setup link of an
 * organization the platform provisioned (APP_URL/setup/organization#token=…).
 * Body: {"token", "password"}. Decided by platform.complete_org_admin_setup (0084) through
 * src/lib/auth/platform-setup.ts: only while the organization is ACTIVE, never adopting an
 * existing login.
 */
export function POST(req: Request) {
  return handleSetupCompletion(req, 'org-admin');
}
