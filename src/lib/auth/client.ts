'use client';

import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

/**
 * Browser-side Better Auth client. Same origin, so no baseURL: the app and the auth
 * endpoints are served together, and a hardcoded URL would be a second answer to the
 * question APP_URL already answers.
 *
 * Password sign-in goes through POST /api/auth/login (server-mediated, so every outcome
 * is recorded as a login event); this client handles the second factor and session
 * reads. Direct calls to /api/auth/sign-in/email from components are a bug — they
 * bypass login-event recording.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

export const { useSession, signOut } = authClient;
