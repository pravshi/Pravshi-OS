import { handleSetupCompletion } from '@/lib/auth/setup-http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/platform/setup/complete — a platform administrator's setup link
 * (APP_URL/platform/setup#token=…), issued by the operator CLI (first administrator,
 * re-issue, recovery) or by an administrator's invitation. Body: {"token", "password"}.
 * Decided by platform.complete_setup (0083) through src/lib/auth/platform-setup.ts.
 */
export function POST(req: Request) {
  return handleSetupCompletion(req, 'platform-admin');
}
