import { Resend } from 'resend';
import { env } from '@/env';

/**
 * Delivery of setup links — by email ONLY (founder policy, 2026-10-29): a provisioned
 * organization's first administrator, and an invited platform administrator. Each link is a
 * bearer credential for an unclaimed login, so it is never shown in the console, returned by an
 * API, logged or audited: it exists in this process's memory and in the recipient's mailbox,
 * nowhere else.
 *
 * Recipient binding is the database's: the pending person's work email, fixed while setup is
 * pending (0086 trigger), or the invited administrator's email, which nothing changes after the
 * invitation (0083). Callers pass what the database recorded, never an address typed at re-issue
 * time.
 *
 * Both RESEND_API_KEY and EMAIL_FROM must be set (as for invitations, src/lib/invitations/
 * email.ts). Without them the console refuses to provision or re-issue rather than create a
 * link it cannot deliver.
 */
let client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export function isSetupEmailConfigured(): boolean {
  return getClient() !== null;
}

export interface OrgAdminSetupEmail {
  to: string;
  fullName: string;
  orgName: string;
  link: string;
  expiresAt: Date;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export function buildOrgAdminSetupEmail(m: OrgAdminSetupEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Set up ${m.orgName} on Pravshi OS`;
  const expires = m.expiresAt.toUTCString();
  const html = `
    <p>Hi ${escapeHtml(m.fullName)},</p>
    <p>An organization has been created for you on Pravshi OS: <strong>${escapeHtml(m.orgName)}</strong>. You are its first administrator.</p>
    <p><a href="${escapeHtml(m.link)}">Create your password</a></p>
    <p>This link works once and expires on ${escapeHtml(expires)}. Then sign in and set up two-factor authentication. If you did not expect this email, ignore it — nothing happens until the link is used.</p>
  `.trim();
  const text = [
    `Hi ${m.fullName},`,
    '',
    `An organization has been created for you on Pravshi OS: ${m.orgName}. You are its first administrator.`,
    '',
    `Create your password: ${m.link}`,
    '',
    `This link works once and expires on ${expires}. If you did not expect this email, ignore it.`,
  ].join('\n');
  return { subject, html, text };
}

export interface PlatformAdminSetupEmail {
  to: string;
  fullName: string;
  link: string;
  expiresAt: Date;
}

export function buildPlatformAdminSetupEmail(m: PlatformAdminSetupEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Your Pravshi OS platform administrator invitation';
  const expires = m.expiresAt.toUTCString();
  const html = `
    <p>Hi ${escapeHtml(m.fullName)},</p>
    <p>You have been invited to administer the Pravshi OS platform.</p>
    <p><a href="${escapeHtml(m.link)}">Create your password</a></p>
    <p>This link works once and expires on ${escapeHtml(expires)}. Then sign in and set up two-factor authentication. If you did not expect this email, ignore it — nothing happens until the link is used.</p>
  `.trim();
  const text = [
    `Hi ${m.fullName},`,
    '',
    'You have been invited to administer the Pravshi OS platform.',
    '',
    `Create your password: ${m.link}`,
    '',
    `This link works once and expires on ${expires}. If you did not expect this email, ignore it.`,
  ].join('\n');
  return { subject, html, text };
}

/** True when the provider accepted the message. Never throws; logs the failure's name only. */
export async function sendOrgAdminSetupEmail(m: OrgAdminSetupEmail): Promise<boolean> {
  return send(m.to, buildOrgAdminSetupEmail(m));
}

/** True when the provider accepted the message. Never throws; logs the failure's name only. */
export async function sendPlatformAdminSetupEmail(m: PlatformAdminSetupEmail): Promise<boolean> {
  return send(m.to, buildPlatformAdminSetupEmail(m));
}

async function send(
  to: string,
  { subject, html, text }: { subject: string; html: string; text: string },
): Promise<boolean> {
  const resend = getClient();
  if (!resend) return false;
  try {
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM as string,
      to,
      subject,
      html,
      text,
    });
    if (error) {
      console.error('[platform] setup email not accepted', { name: error.name });
      return false;
    }
    return true;
  } catch (e) {
    console.error('[platform] setup email failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}
