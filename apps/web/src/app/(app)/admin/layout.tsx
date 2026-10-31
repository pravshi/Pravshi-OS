import { requireMfaEnrolled } from '@/lib/auth/mfa-enforcement';

/**
 * (app)/admin/layout — every /admin/* page passes through here.
 *
 * Phase 1 MFA hardening: a signed-in user who holds users.manage or
 * roles.manage must have a verified TOTP factor before touching any admin
 * page. requireMfaEnrolled() redirects to /me/security?enrollment=required
 * when the gate is unmet.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireMfaEnrolled();
  return <>{children}</>;
}
