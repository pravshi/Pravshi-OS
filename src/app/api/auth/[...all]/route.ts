import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth/server';

/**
 * The Better Auth endpoint. Backend infrastructure, not a page — there is no login UI in
 * this task.
 *
 * This is the first public HTTP surface in the repository, so what it does NOT expose is
 * worth stating: sign-up is refused twice over (disableSignUp, plus the before-hook in
 * server.ts), and a session it issues grants nothing on its own. Every route that goes on
 * to read business data still goes through withAuthorizedDb() and still meets RLS.
 */
export const { GET, POST } = toNextJsHandler(auth);
