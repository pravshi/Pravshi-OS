'use client';

import { authClient } from '@/lib/auth/client';

/**
 * The console's one way to call /api/platform: JSON in, a typed result out, and the gate's
 * answers turned into what the administrator should do next. Nothing here decides access —
 * the route's gate and the database do.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  MFA_REQUIRED: 'Two-factor authentication is required. Enrol it under Security.',
  FORBIDDEN: 'You are not allowed to do this.',
  STEP_UP_REQUIRED:
    'This action needs a recent sign-in. Sign in again (password and code), then repeat it.',
  RATE_LIMITED: 'Too many attempts. Wait a while and try again.',
  PLATFORM_UNAVAILABLE: 'The platform console is not available on this deployment.',
  INVALID_INPUT: 'Check the highlighted fields.',
  FORBIDDEN_ORIGIN: 'The request was refused.',
  INTERNAL: 'Something went wrong. Nothing was changed.',
};

export async function platformApi<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/platform${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: 'The server could not be reached. Try again.' };
  }
  const data = (await res.json().catch(() => null)) as
    (T & { error?: string; message?: string; field?: string | null }) | null;
  if (res.ok && data) return { ok: true, data };
  const code = data?.error ?? 'INTERNAL';
  if (code === 'UNAUTHENTICATED') {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const field = data?.field ? ` (${data.field})` : '';
  return {
    ok: false,
    code,
    message:
      (data?.message ?? MESSAGES[code] ?? MESSAGES.INTERNAL) +
      (code === 'INVALID_INPUT' ? field : ''),
  };
}

/** Step-up: end this session and sign in again, coming back to this page. */
export async function signInAgain(): Promise<void> {
  await authClient.signOut();
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
}

/** A fresh key per form submission; a retry of the same submission reuses it. */
export const newIdempotencyKey = (): string => crypto.randomUUID().replace(/-/g, '');
