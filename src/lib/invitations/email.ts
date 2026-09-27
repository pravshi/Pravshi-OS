import { Resend } from 'resend';
import { env } from '@/env';

/**
 * Invitation email delivery, via Resend.
 *
 * Sending is best-effort BY DESIGN, not by accident: the invitation row is the source of
 * truth, and the create endpoint returns the token to the admin when delivery is not
 * configured or fails, so the link can always be shared another way. An invitation that
 * exists but whose email bounced is recoverable; an email sent for an invitation that
 * was rolled back is a live token to nothing.
 *
 * Both RESEND_API_KEY and EMAIL_FROM must be set for delivery. EMAIL_FROM must be an
 * address on a domain verified in Resend — there is no safe default to invent.
 */

export interface InvitationEmail {
  to: string;
  orgName: string;
  inviterName: string;
  acceptUrl: string;
  expiresAt: Date;
}

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export function isEmailConfigured(): boolean {
  return getClient() !== null;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export async function sendInvitationEmail(invite: InvitationEmail): Promise<boolean> {
  const resend = getClient();
  if (!resend) return false;

  const subject = `You're invited to join ${invite.orgName} on Pravshi OS`;
  const html = `
    <p>Hi,</p>
    <p>${escapeHtml(invite.inviterName)} has invited you to join <strong>${escapeHtml(invite.orgName)}</strong> on Pravshi OS.</p>
    <p><a href="${escapeHtml(invite.acceptUrl)}">Accept your invitation</a></p>
    <p>This link is single-use and expires on ${escapeHtml(invite.expiresAt.toUTCString())}. If you did not expect this invitation, you can safely ignore it.</p>
  `.trim();

  try {
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM as string,
      to: invite.to,
      subject,
      html,
    });
    if (error) {
      console.error('[invitations] email delivery failed', { name: error.name });
      return false;
    }
    return true;
  } catch (e) {
    console.error('[invitations] email delivery threw', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}
