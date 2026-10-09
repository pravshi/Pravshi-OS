import { Resend } from 'resend';
import { env } from '@/env';

/**
 * Password-reset email delivery, via Resend.
 *
 * Best-effort, like the invitation mailer: the password_resets row is the source of
 * truth, and a reset whose email bounced is recoverable — the user simply requests
 * again. Sending is skipped entirely when delivery is not configured
 * (no RESEND_API_KEY or EMAIL_FROM), in which case the request still answers with
 * generic success so the endpoint never leaks whether the email exists.
 */

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export function isResetEmailConfigured(): boolean {
  return getClient() !== null;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export interface ResetEmailContent {
  subject: string;
  html: string;
}

/**
 * The reset email's content — the ONE source for it, whoever delivers it.
 * The pre-auth request path enqueues these exact strings on the email job
 * plane (F-11-06, src/lib/auth/password-reset.ts); the admin credential-reset
 * path sends them inline via sendResetEmail below. One builder, so the two
 * delivery mechanisms can never drift into different emails.
 */
export function buildResetEmailContent(resetUrl: string): ResetEmailContent {
  const subject = 'Reset your Pravshi OS password';
  const html = `
    <p>Hi,</p>
    <p>We received a request to reset the password for your Pravshi OS account.</p>
    <p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>
    <p>This link is single-use and expires in one hour. If you did not request this, you can safely ignore it — your password will not change.</p>
  `.trim();
  return { subject, html };
}

export async function sendResetEmail(to: string, resetUrl: string): Promise<boolean> {
  const resend = getClient();
  if (!resend) return false;

  const { subject, html } = buildResetEmailContent(resetUrl);

  try {
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM as string,
      to,
      subject,
      html,
    });
    if (error) {
      console.error('[auth] reset email delivery failed', { name: error.name });
      return false;
    }
    return true;
  } catch (e) {
    console.error('[auth] reset email delivery threw', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}
