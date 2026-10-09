'use client';

import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

/**
 * Browser-side Better Auth client. Same origin, so no baseURL: the app and the auth
 * endpoints are served together, and a hardcoded URL would be a second answer to the
 * question APP_URL already answers.
 *
 * Password sign-in goes through POST /api/auth/login (server-mediated: it owns body
 * validation, the origin check and the enrolment steer); this client handles the
 * second factor and session reads. Since Phase 11 the lockout and login-event
 * recording live in the auth hooks, so a direct call to /api/auth/sign-in/email no
 * longer bypasses either — but components still use the mediated route, which is
 * the one path the sign-in UI contract is tested against.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

export const { useSession, signOut } = authClient;
