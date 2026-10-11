/**
 * Phase 6 — Job Handlers: notification, email, webhook, cleanup.
 *
 * Owner: Job Handler Engineer (contracts §6). Other agents MUST NOT modify
 * this file. `registerHandler` is imported from ./worker (Worker Runtime
 * Engineer, contract §3.4); the four registrations at the bottom of this
 * module are the only coupling between the two files.
 *
 * ── NOTIFICATION SYSTEM NOTE ────────────────────────────────────────────────
 * Contract §6 says the notification handler writes to "the notifications
 * table (existing system)". No notifications table or notification service
 * exists anywhere in this repo (searched: drizzle/*.sql, src/lib, Phase 5
 * workflows — only the unimplemented `send_notification` action stub in
 * src/lib/workflows/actions.ts references notifications).
 *
 * Decision: this handler writes via parameterized SQL to
 * `public.notifications` with the minimal DDL below. The DB/Migration
 * Engineer MUST create the table (suggested DDL is documented in
 * NOTIFICATIONS_TABLE_DDL); until then the handler fails CLOSED with a
 * non-retryable CONFIG_ERROR (42P01 → NOTIFICATIONS_TABLE_MISSING) so jobs
 * dead-letter loudly instead of silently dropping notifications or retrying
 * forever.
 *
 * ── SECURITY INVARIANTS (all handlers) ──────────────────────────────────────
 * - org_id comes from ctx.job.orgId (the JOB ROW), never from the payload
 *   (§3.6 actor authority rule). Every query re-states org_id.
 * - Secrets (webhook signatureSecret) and email bodies are NEVER logged.
 * - Webhook handler enforces SSRF protection before any network I/O.
 * - Cleanup handler NEVER deletes non-terminal jobs (§3.1: terminal =
 *   'succeeded' | 'cancelled' only).
 */
import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { env, webhookSigningSecret } from '@/env';
import { sendViaResend } from '../integrations/providers/email/send';
import { decryptSecret, IntegrationsVaultError } from '../integrations/secrets';
import { withAuthorizedDb } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import {
  CleanupPayloadSchema,
  EmailPayloadSchema,
  NotificationPayloadSchema,
  WebhookPayloadSchema,
  type Job,
} from './types';
import { registerHandler } from './worker';
import type { JobExecutionContext, JobHandler } from './worker';

/** Suggested DDL for the DB/Migration Engineer (see module header). */
export const NOTIFICATIONS_TABLE_DDL = `
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  person_id uuid references public.people (id),
  title text not null,
  message text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
`.trim();

// ── Error helpers ─────────────────────────────────────────────────────────────

/**
 * Throw an Error carrying a machine-readable `code` (and optional extra
 * fields such as `statusCode`). The worker's fail path runs classifyError()
 * (retry.ts), which maps:
 *   CONFIG_ERROR / VALIDATION_ERROR / NOT_FOUND / ZOD_ERROR → non-retryable
 *   unknown codes                                            → retryable (fail-open)
 *   err.statusCode 4xx                                      → non-retryable
 *   err.statusCode 5xx                                      → retryable
 */
type CodedError = Error & { code: string; [key: string]: unknown };

export function jobFail(code: string, message: string, extra?: Record<string, unknown>): never {
  const err = new Error(message) as CodedError;
  err.code = code;
  if (extra) Object.assign(err, extra);
  throw err;
}

/**
 * The SQLSTATE of a database error, following the repository convention
 * (auth/bootstrap-setup.ts, authz/require-permission.ts): drizzle wraps the
 * driver error, so the code may live on the error or on its `cause`. Reading
 * only the outer error silently disables every SQLSTATE branch below — the
 * Phase 8 DB verification proved the 23505 dedupe catch never fired against
 * the real driver for exactly that reason.
 */
export function sqlstateOf(e: unknown): string | null {
  for (const candidate of [e, (e as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Non-retryable: caller/config/data problem — retrying cannot help. */
export function failConfig(message: string): never {
  jobFail('CONFIG_ERROR', message);
}

/** Non-retryable: payload failed validation. */
export function failValidation(message: string): never {
  jobFail('VALIDATION_ERROR', message);
}

/** Non-retryable: referenced record does not exist in this org. */
export function failNotFound(message: string): never {
  jobFail('NOT_FOUND', message);
}

// ── 1. NOTIFICATION ───────────────────────────────────────────────────────────

/**
 * Accepts the canonical types.ts shape (personId/title/message/data) and —
 * per the task contract — the alias shape
 * { recipientPersonId, title, body, entityType?, entityId? }.
 * Aliases are folded into the canonical shape before validation.
 */
const NotificationAliasSchema = z.strictObject({
  recipientPersonId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  entityType: z.string().max(128).optional(),
  entityId: z.string().max(256).optional(),
});

export interface NormalizedNotification {
  personId: string | null;
  title: string;
  message: string;
  data: Record<string, unknown>;
  /**
   * Phase 8: notification event type, read from `data.type` (written by the
   * Phase 8 notification service / workflow actions). Defaults to
   * SYSTEM_ALERT — the same default migration 0052 uses when backfilling the
   * new `type` column. Format-validated only; the enum contract is enforced
   * at the service/API boundary, not on the worker plane.
   */
  type: string;
  /**
   * Phase 8: idempotency key, read from `data.eventId` (nullable) →
   * the `event_id` column (migration 0052).
   */
  eventId: string | null;
}

/** data.type → column value: non-empty string ≤ 64 chars, else SYSTEM_ALERT. */
function readNotificationType(data: Record<string, unknown>): string {
  const raw = data['type'];
  if (typeof raw !== 'string') return 'SYSTEM_ALERT';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 64) return 'SYSTEM_ALERT';
  return trimmed;
}

/** data.eventId → column value: string ≤ 256 chars, else null. */
function readNotificationEventId(data: Record<string, unknown>): string | null {
  const raw = data['eventId'];
  if (typeof raw !== 'string' || raw === '' || raw.length > 256) return null;
  return raw;
}

export function normalizeNotificationPayload(raw: unknown): NormalizedNotification {
  const parsed = NotificationPayloadSchema.safeParse(raw);
  if (parsed.success) {
    const base = {
      personId: parsed.data.personId ?? null,
      title: parsed.data.title,
      message: parsed.data.message,
      data: parsed.data.data ?? {},
    };
    return {
      ...base,
      type: readNotificationType(base.data),
      eventId: readNotificationEventId(base.data),
    };
  }
  // Alias shape (task contract §6 payload).
  const alias = NotificationAliasSchema.safeParse(raw);
  if (alias.success) {
    const data: Record<string, unknown> = {};
    if (alias.data.entityType !== undefined) data.entityType = alias.data.entityType;
    if (alias.data.entityId !== undefined) data.entityId = alias.data.entityId;
    const base = {
      personId: alias.data.recipientPersonId ?? null,
      title: alias.data.title,
      message: alias.data.body,
      data,
    };
    return {
      ...base,
      type: readNotificationType(base.data),
      eventId: readNotificationEventId(base.data),
    };
  }
  // Surface the canonical schema's issues (non-retryable via ZodError name).
  NotificationPayloadSchema.parse(raw);
  throw new Error('unreachable');
}

async function assertPersonInOrg(
  auth: Authorization,
  orgId: string,
  personId: string,
): Promise<void> {
  // The worker runs as the nil-UUID system actor, which is not a person row
  // and therefore cannot see the recipient through people_select RLS. Ask the
  // bounded SECURITY DEFINER check added by migration 0052 instead of reading
  // public.people directly: it returns only whether this exact person is a
  // non-deleted member of the job row's organization.
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ recipient_exists: boolean }>(
      sql`select public.notifications_recipient_exists(
            ${orgId}::uuid,
            ${personId}::uuid
          ) as recipient_exists`,
    ),
  );
  if (rows.rows[0]?.recipient_exists !== true) {
    failNotFound(`notification recipient ${personId} is not an active person in org ${orgId}`);
  }
}

/**
 * `notification` job → writes one row to public.notifications.
 * Recipient (when given) is verified to belong to ctx.job.orgId.
 */
export const handleNotification: JobHandler = async (ctx: JobExecutionContext) => {
  const orgId = ctx.job.orgId;
  const n = normalizeNotificationPayload(ctx.job.payload);

  if (n.personId !== null) {
    await assertPersonInOrg(ctx.auth, orgId, n.personId);
  }

  try {
    // Worker-plane write (0047): the system actor cannot satisfy the
    // org-scoped RLS INSERT policy on public.notifications (authz.org_id()
    // and authz.has() resolve against people, where the system actor has no
    // row), so the insert goes through the SECURITY DEFINER
    // notifications_insert() privilege path — the jobs_claim_next() pattern.
    // org_id comes from the job row; the recipient was verified in-org above
    // (and re-verified by the person_org guard trigger in SQL).
    //
    // Phase 8: the extended signature carries the type/event_id columns
    // (migration 0052, Workstream A):
    //   notifications_insert(p_org_id, p_person_id, p_title, p_message,
    //                        p_data, p_type default 'SYSTEM_ALERT',
    //                        p_event_id default null)
    // When 0052 is not applied yet, 42883 falls back to the Phase-6 5-arg
    // insert so the notification is still delivered (the 0052 function keeps
    // the 5-arg call shape working via defaults once applied).
    try {
      await withAuthorizedDb(ctx.auth.ctx, (tx) =>
        tx.execute(
          sql`select public.notifications_insert(
                 ${orgId}::uuid,
                 ${n.personId}::uuid,
                 ${n.title},
                 ${n.message},
                 ${JSON.stringify(n.data)}::jsonb,
                 ${n.type},
                 ${n.eventId}
               )`,
        ),
      );
    } catch (extendedErr) {
      if (sqlstateOf(extendedErr) !== '42883') throw extendedErr;
      console.warn(
        `[jobs] extended notifications_insert() unavailable job=${ctx.job.id} ` +
          '— falling back to the 5-argument signature (type/event_id defaulted)',
      );
      await withAuthorizedDb(ctx.auth.ctx, (tx) =>
        tx.execute(
          sql`select public.notifications_insert(
                 ${orgId}::uuid,
                 ${n.personId}::uuid,
                 ${n.title},
                 ${n.message},
                 ${JSON.stringify(n.data)}::jsonb
               )`,
        ),
      );
    }
  } catch (err) {
    // 42P01 = undefined_table, 42883 = undefined_function: migration 0047
    // has not been applied yet (see module header). Fail closed and loud —
    // non-retryable.
    const code = sqlstateOf(err);
    if (code === '42P01' || code === '42883') {
      failConfig(
        'NOTIFICATIONS_TABLE_MISSING: public.notifications / notifications_insert() ' +
          'do not exist; apply migration 0047_notifications. Notification NOT written.',
      );
    }
    // 23505: the (org_id, event_id) unique partial index fired (migration
    // 0052) — a redelivered event was already written by an earlier
    // attempt. The DB already deduped the row; the job must not crash or
    // retry on duplicates. Success-as-no-op.
    if (code === '23505') {
      console.info(
        `[jobs] notification duplicate job=${ctx.job.id} event_id=${n.eventId} ` +
          '— already delivered, no-op (unique index deduped)',
      );
      return;
    }
    throw err;
  }

  console.info(
    `[jobs] notification written job=${ctx.job.id} org=${orgId} ` +
      `recipient=${n.personId ?? 'org-broadcast'} type=${n.type} title_len=${n.title.length}`,
  );
};

// ── 2. EMAIL ──────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function assertValidEmailAddress(value: string): void {
  if (!EMAIL_RE.test(value) || value.length > 320) {
    failValidation(`invalid email address: ${value.slice(0, 64)}`);
  }
}

const EmailAliasSchema = z.strictObject({
  to: z.union([z.string(), z.array(z.string()).min(1).max(50)]),
  subject: z.string().min(1).max(300),
  bodyText: z.string().max(200_000).optional(),
  bodyHtml: z.string().max(500_000).optional(),
});

export interface NormalizedEmail {
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

export function normalizeEmailPayload(raw: unknown): NormalizedEmail {
  const parsed = EmailPayloadSchema.safeParse(raw);
  if (parsed.success) {
    const to = Array.isArray(parsed.data.to) ? parsed.data.to : [parsed.data.to];
    to.forEach(assertValidEmailAddress);
    return { to, subject: parsed.data.subject, text: parsed.data.text, html: parsed.data.html };
  }
  // Alias shape (task contract: bodyText/bodyHtml).
  const alias = EmailAliasSchema.safeParse(raw);
  if (alias.success) {
    const to = Array.isArray(alias.data.to) ? alias.data.to : [alias.data.to];
    to.forEach(assertValidEmailAddress);
    if (alias.data.bodyText === undefined && alias.data.bodyHtml === undefined) {
      failValidation('email payload needs bodyText or bodyHtml');
    }
    return {
      to,
      subject: alias.data.subject,
      text: alias.data.bodyText,
      html: alias.data.bodyHtml,
    };
  }
  EmailPayloadSchema.parse(raw); // throws ZodError (non-retryable)
  throw new Error('unreachable');
}

export interface EmailProviderInput {
  job: Job;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Idempotency key handed to the provider — prevents double-send on retry. */
  idempotencyKey: string;
}

export interface EmailProviderResult {
  messageId: string;
  idempotencyKey: string;
}

/**
 * Build a deterministic idempotency key for a send. Retries of the same job
 * produce the same key, so a provider that honors Idempotency-Key headers
 * (Resend, Postmark, …) will not double-send.
 */
export function buildEmailIdempotencyKey(job: Job): string {
  return `pravshi-email:${job.id}:${job.dedupKey ?? 'no-dedup'}`;
}

/**
 * Email provider abstraction.
 *
 * Behavior:
 * - EMAIL_PROVIDER unset but RESEND_API_KEY set → treated as 'resend'. That
 *   is the configuration the auth mailers (invitations) already use, and the
 *   one DEPLOYMENT.md documents; password-reset email travels as an `email`
 *   job (Phase 11, F-11-06), so without this default a deployment that
 *   configured only RESEND_API_KEY + EMAIL_FROM would send invitations but
 *   silently dead-letter every reset email.
 * - No provider configured (EMAIL_PROVIDER and RESEND_API_KEY both unset) →
 *   throws CONFIG_ERROR (code 'CONFIG_ERROR' → classifyError marks it
 *   NON-RETRYABLE: "EMAIL_PROVIDER_UNCONFIGURED"). Retrying a job that can
 *   never send is pointless, so this dead-letters immediately.
 * - EMAIL_PROVIDER=resend → the real adapter
 *   (src/lib/integrations/providers/email/send.ts, Phase 10 §4.6): sends via
 *   the Resend SDK with the job's idempotency key, resolving its credential
 *   (EMAIL_PROVIDER_API_KEY, falling back to RESEND_API_KEY) and reporting
 *   failures as normalised EmailSendError codes — the same CONFIG_ERROR /
 *   VALIDATION_ERROR non-retryable + retryable PROVIDER_ERROR contract.
 * - Any OTHER provider configured → STILL FAILS CLOSED: throws CONFIG_ERROR
 *   ("EMAIL_PROVIDER_NOT_IMPLEMENTED", non-retryable). No adapter exists for
 *   it yet, and a synthetic success would be a false-delivery integrity
 *   failure — the job must never transition to `succeeded` without an
 *   actual send.
 */
export async function sendEmailViaProvider(
  input: EmailProviderInput,
): Promise<EmailProviderResult> {
  // An explicit EMAIL_PROVIDER always wins; only its absence defaults to
  // Resend, and only when the auth mailers' Resend key exists.
  const provider = env.EMAIL_PROVIDER ?? (env.RESEND_API_KEY ? 'resend' : undefined);
  const apiKey = env.EMAIL_PROVIDER_API_KEY;

  // Phase 10 (Wave P): 'resend' is wired. The adapter resolves its own
  // credential (EMAIL_PROVIDER_API_KEY, falling back to RESEND_API_KEY) and
  // sender, so this branch runs before the unconfigured gate below.
  if (provider === 'resend') {
    return sendViaResend({
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      idempotencyKey: input.idempotencyKey,
    });
  }

  if (!provider || !apiKey) {
    console.warn(
      `[jobs] email provider unconfigured job=${input.job.id} ` +
        `to_count=${input.to.length} subject_len=${input.subject.length}`,
    );
    failConfig(
      'EMAIL_PROVIDER_UNCONFIGURED: set EMAIL_PROVIDER and EMAIL_PROVIDER_API_KEY ' +
        'to enable outbound email. Job dead-letters (non-retryable) until configured.',
    );
  }

  // Fail closed (CONFIG_ERROR → non-retryable → dead-letter): EMAIL_PROVIDER
  // names a provider with no adapter — nothing actually transmits, and
  // returning a synthetic messageId would let the job "succeed" without any
  // email being sent.
  console.warn(
    `[jobs] email provider not implemented job=${input.job.id} provider=${provider} ` +
      `to_count=${input.to.length} idempotency_key=${input.idempotencyKey}`,
  );
  jobFail(
    'CONFIG_ERROR',
    'EMAIL_PROVIDER_NOT_IMPLEMENTED: EMAIL_PROVIDER is configured but no real ' +
      'email transmission is implemented. Wire a real provider in ' +
      'sendEmailViaProvider() (fetch to the provider API with the idempotency ' +
      'key) before enabling email jobs. Job dead-letters (non-retryable).',
  );
}

/**
 * `email` job → provider send with retry + dedup.
 * Dedup: the idempotency key is derived from the job id (+ dedupKey), so a
 * retried job re-sends with the SAME key and a compliant provider will not
 * duplicate the message. Never logs the email body.
 */
export const handleEmail: JobHandler = async (ctx: JobExecutionContext) => {
  const e = normalizeEmailPayload(ctx.job.payload);
  const idempotencyKey = buildEmailIdempotencyKey(ctx.job);
  const result = await sendEmailViaProvider({
    job: ctx.job,
    to: e.to,
    subject: e.subject,
    text: e.text,
    html: e.html,
    idempotencyKey,
  });
  console.info(
    `[jobs] email sent job=${ctx.job.id} message_id=${result.messageId} ` +
      `idempotency_key=${result.idempotencyKey}`,
  );
};

// ── 3. WEBHOOK (SSRF-PROTECTED) ──────────────────────────────────────────────

/** Max bytes of response body we will buffer. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB
/** Max redirects followed; every hop is re-validated through the SSRF guard. */
export const WEBHOOK_MAX_REDIRECTS = 2;

/**
 * Phase 10 (Wave W-out) signing header set — fixed here as the §4.5
 * contract note, and documented for receivers in the webhook security
 * guide (Wave M):
 *   x-pravshi-signature   `sha256=<hex>` HMAC-SHA256 over the raw body
 *   x-pravshi-timestamp   unix seconds when this attempt was sent; the
 *                         receiver enforces its replay window against it
 *                         (the signature covers the body only — the
 *                         timestamp is routing metadata, not signed
 *                         content, so legacy env-ref deliveries verify
 *                         exactly as before)
 *   x-pravshi-webhook-id  the job id (per-attempt correlation)
 * The envelope body additionally carries the delivery id (`id`), the
 * receiver's stable dedup key across retries of the same delivery.
 */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-pravshi-timestamp';

export interface SsrfCheck {
  allowed: boolean;
  reason?: string;
}

const BLOCKED_HOST_SUFFIXES = ['.internal', '.local'];

/**
 * Convert an IPv4 address in any inet_aton form to 4 bytes.
 * Handles: dotted decimal, octal (0177.0.0.1), hex (0x7f.0.0.1),
 * and bare 32-bit integers ('2130706433' → 127.0.0.1).
 * Returns null when the string is not an IPv4 literal.
 */
export function parseIpv4Aton(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 10) return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    // A leading-zero part containing 8/9 is invalid octal: WHATWG's IPv4
    // parser and inet_aton both reject it outright. Never let parseInt
    // silently truncate it into a different address ('08' → 0).
    else if (/^0[0-9]/.test(p)) return null;
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    nums.push(n);
  }
  let v: number;
  const n0 = nums[0] as number;
  const n1 = nums[1] as number | undefined;
  const n2 = nums[2] as number | undefined;
  const n3 = nums[3] as number | undefined;
  if (nums.length === 1) v = n0;
  else if (nums.length === 2 && n1 !== undefined) {
    if (n0 > 0xff || n1 > 0xffffff) return null;
    v = (n0 << 24) + n1;
  } else if (nums.length === 3 && n1 !== undefined && n2 !== undefined) {
    if (n0 > 0xff || n1 > 0xff || n2 > 0xffff) return null;
    v = (n0 << 24) + (n1 << 16) + n2;
  } else if (nums.length === 4 && n1 !== undefined && n2 !== undefined && n3 !== undefined) {
    if (nums.some((n) => n > 0xff)) return null;
    v = (n0 << 24) + (n1 << 16) + (n2 << 8) + n3;
  } else {
    return null;
  }
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function ipv4ToNumber(b: [number, number, number, number]): number {
  return (b[0] * 256 ** 3 + b[1] * 256 ** 2 + b[2] * 256 + b[3]) >>> 0;
}

function inCidr(
  b: [number, number, number, number],
  base: [number, number, number, number],
  bits: number,
): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(b) & mask) === (ipv4ToNumber(base) & mask);
}

/** Blocked IPv4 ranges: private, loopback, link-local (covers 169.254.169.254),
 *  CGNAT, and the unspecified address. */
const BLOCKED_V4: Array<[[number, number, number, number], number, string]> = [
  [[10, 0, 0, 0], 8, '10.0.0.0/8 (private)'],
  [[172, 16, 0, 0], 12, '172.16.0.0/12 (private)'],
  [[192, 168, 0, 0], 16, '192.168.0.0/16 (private)'],
  [[127, 0, 0, 0], 8, '127.0.0.0/8 (loopback)'],
  [[0, 0, 0, 0], 8, '0.0.0.0/8 (unspecified)'],
  [[169, 254, 0, 0], 16, '169.254.0.0/16 (link-local; includes 169.254.169.254 metadata)'],
  [[100, 64, 0, 0], 10, '100.64.0.0/10 (CGNAT)'],
];

/**
 * True when a host string is composed solely of inet_aton characters
 * (digits, hex letters a–f, the 0x prefix marker, dots) and contains at
 * least one digit. Such a string is an IP-literal ATTEMPT, never a plausible
 * public DNS name: every character in it is meaningful to an IPv4 parser,
 * so when the strict parsers (WHATWG URL, parseIpv4Aton) refuse it, it sits
 * exactly in the parser-differential gap this guard exists to close.
 */
export function looksLikeIpv4Literal(host: string): boolean {
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return false;
  if (!/[0-9]/.test(host)) return false;
  return host.split('.').every((label) => label.length > 0);
}

/**
 * Parse an IPv6 literal (brackets, zone id, and dotted-quad tail all
 * tolerated) into its 16 bytes. Returns null when the input is not a valid
 * IPv6 address. Range checks run on the bytes, never on the textual form:
 * `new URL()` serializes [::ffff:127.0.0.1] as [::ffff:7f00:1], so any
 * text-pattern check for the dotted tail silently misses the mapped form.
 */
export function parseIpv6Bytes(host: string): number[] | null {
  let h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  if (isIP(h) !== 6) return null;

  // Rewrite a dotted-quad tail as its two hex groups, then parse uniformly.
  if (h.includes('.')) {
    const lastColon = h.lastIndexOf(':');
    if (lastColon === -1) return null;
    const tail = h.slice(lastColon + 1);
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return null;
    const quad = tail.split('.').map(Number);
    if (quad.some((n) => n > 255)) return null;
    const hi = (((quad[0] as number) << 8) | (quad[1] as number)).toString(16);
    const lo = (((quad[2] as number) << 8) | (quad[3] as number)).toString(16);
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] as string);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const tailGroups = parseGroups(halves[1] as string);
    if (tailGroups === null) return null;
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null; // '::' must compress at least one group
    groups = [...head, ...new Array<number>(missing).fill(0), ...tailGroups];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

/**
 * True when an IPv4 literal (any inet_aton form) or IPv6 literal is blocked.
 * IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) IPv6 forms are
 * unwrapped and judged by their embedded IPv4 address. A string that is not
 * a valid literal but is composed purely of inet_aton characters (see
 * looksLikeIpv4Literal) is a malformed IP literal and fails closed: e.g.
 * 0x7f.0x0.0x0x1, whose final part defeats WHATWG's ends-in-a-number
 * heuristic, so `new URL()` leaves it un-normalized, masquerading as a DNS
 * hostname that no IP range check would ever engage on.
 */
export function isBlockedIpLiteral(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  const v4 = parseIpv4Aton(h);
  if (v4) {
    return BLOCKED_V4.some(([base, bits]) => inCidr(v4, base, bits));
  }

  if (h.includes(':')) {
    const b = parseIpv6Bytes(h);
    if (!b) return true; // colon-bearing but not parseable IPv6: fail closed
    const byte = (i: number): number => b[i] as number;
    // :: (unspecified) and ::1 (loopback)
    if (b.slice(0, 15).every((x) => x === 0) && (byte(15) === 0 || byte(15) === 1)) return true;
    if (byte(0) === 0xfe && (byte(1) & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if ((byte(0) & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 embed an IPv4
    // address in the last 32 bits; judge that address by the IPv4 ranges.
    const embedded = `${byte(12)}.${byte(13)}.${byte(14)}.${byte(15)}`;
    if (b.slice(0, 10).every((x) => x === 0) && byte(10) === 0xff && byte(11) === 0xff) {
      return isBlockedIpLiteral(embedded);
    }
    if (b.slice(0, 12).every((x) => x === 0)) {
      return isBlockedIpLiteral(embedded);
    }
    return false;
  }

  // Malformed IP literal (see header): fail closed.
  if (looksLikeIpv4Literal(h)) return true;
  return false;
}

export function isBlockedHostname(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return 'localhost';
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return `blocked suffix ${suffix}`;
  }
  if (!h.includes('.')) return 'single-label hostname';
  return null;
}

/**
 * Static (no-DNS) SSRF check for a webhook URL. Returns { allowed:false,
 * reason } for anything that must never be fetched. DNS resolution and the
 * resolved-IP check happen in assertWebhookTargetAllowed().
 */
export function checkWebhookUrlStatic(rawUrl: string): SsrfCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `scheme ${url.protocol} not allowed (http/https only)` };
  }
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: 'userinfo in URL is not allowed' };
  }
  const blockedHost = isBlockedHostname(url.hostname);
  if (blockedHost) return { allowed: false, reason: `blocked hostname: ${blockedHost}` };
  if (isBlockedIpLiteral(url.hostname)) {
    return { allowed: false, reason: `blocked IP literal: ${url.hostname}` };
  }
  return { allowed: true };
}

/**
 * Full SSRF gate: static check, then DNS resolution — EVERY resolved address
 * must pass the IP check (blocks DNS rebinding to private ranges). Returns
 * the first allowed address to pin the connection to (see fetchWebhookPinned).
 */
export async function assertWebhookTargetAllowed(rawUrl: string): Promise<{
  url: URL;
  pinnedIp: string;
  pinnedFamily: 4 | 6;
}> {
  const staticCheck = checkWebhookUrlStatic(rawUrl);
  if (!staticCheck.allowed) {
    failValidation(`webhook URL blocked by SSRF guard: ${staticCheck.reason}`);
  }
  const url = new URL(rawUrl);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(url.hostname, { all: true });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    // Transient DNS failure → retryable (classifyError maps ENOTFOUND/EAI_AGAIN).
    const retryable = new Error(
      `webhook DNS lookup failed for ${url.hostname}: ${(err as Error).message}`,
    ) as CodedError;
    retryable.code = typeof code === 'string' ? code : 'EAI_AGAIN';
    throw retryable;
  }
  if (addresses.length === 0) {
    failValidation(`webhook DNS lookup returned no addresses for ${url.hostname}`);
  }
  for (const a of addresses) {
    if (isBlockedIpLiteral(a.address)) {
      failValidation(
        `webhook URL blocked by SSRF guard: ${url.hostname} resolves to blocked IP ${a.address}`,
      );
    }
  }
  const first = addresses[0];
  if (!first) failValidation(`webhook DNS lookup returned no addresses for ${url.hostname}`);
  return { url, pinnedIp: first.address, pinnedFamily: first.family === 6 ? 6 : 4 };
}

/** HMAC-SHA256 signature for a webhook body. The secret is never logged. */
export function signWebhookBody(bodyBytes: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(bodyBytes).digest('hex')}`;
}

export type WebhookOutcome = 'ok' | 'client-error' | 'server-error';

export function classifyWebhookStatus(status: number): WebhookOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 400 && status < 500) return 'client-error';
  return 'server-error';
}

interface WebhookFetchResult {
  status: number;
  bytes: number;
  headers: Record<string, string | string[] | undefined>;
}

function serializeWebhookBody(body: unknown): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(JSON.stringify(body), 'utf8');
}

/**
 * Perform the HTTP request with the TCP connection pinned to the SSRF-verified
 * IP (custom `lookup`), so DNS cannot change between validation and connect
 * (TOCTOU/DNS-rebinding mitigation). Host header and TLS SNI still use the
 * original hostname from the URL.
 */
function fetchWebhookPinned(
  url: URL,
  opts: {
    method: string;
    headers: Record<string, string>;
    body: Buffer;
    timeoutMs: number;
    pinnedIp: string;
    pinnedFamily: 4 | 6;
    signal?: AbortSignal;
  },
): Promise<WebhookFetchResult> {
  return new Promise((resolve, reject) => {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      {
        method: opts.method,
        headers: opts.headers,
        // Pin the connection to the verified IP; hostname (Host/SNI) unchanged.
        lookup: (_hostname, _options, callback) => {
          callback(null, opts.pinnedIp, opts.pinnedFamily);
        },
      },
      (res) => {
        // Drain with a 1 MiB cap; we log only status + byte count, never content.
        let bytes = 0;
        let tooLarge = false;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > WEBHOOK_MAX_RESPONSE_BYTES && !tooLarge) {
            tooLarge = true;
            req.destroy(new Error('UPSTREAM_RESPONSE_TOO_LARGE'));
          }
        });
        res.on('end', () => {
          if (!tooLarge) resolve({ status: res.statusCode ?? 0, bytes, headers: res.headers });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`webhook request timed out after ${opts.timeoutMs}ms`));
    });
    req.setTimeout(opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new Error('webhook aborted: worker shutting down'));
      else
        opts.signal.addEventListener('abort', () => req.destroy(new Error('webhook aborted')), {
          once: true,
        });
    }
    if (opts.body.length > 0) req.write(opts.body);
    req.end();
  });
}

export interface NormalizedWebhook {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body: Buffer;
  /** Resolved signing secret (never logged). Undefined = no signature. */
  signatureSecret?: string;
  timeoutMs: number;
  /** Phase 10: org subscription this delivery belongs to (ids only — safe
   *  to log; the secret itself is never a payload or log field, §4.5). */
  subscriptionId?: string;
  deliveryId?: string;
}

/**
 * Resolve a `signatureSecretRef` to its secret value via
 * env WEBHOOK_SIGNING_SECRET_<REF>. The value is never logged — only a
 * boolean "signed/unsigned" is recorded.
 */
function resolveWebhookSecretRef(ref: string | undefined): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  // Dynamic per-ref secret (WEBHOOK_SIGNING_SECRET_<REF>); read through the
  // env.ts helper — the one sanctioned process.env read path.
  const value = webhookSigningSecret(ref);
  if (!value) {
    failConfig(
      `webhook signatureSecretRef '${ref}' is not configured ` +
        `(expected env WEBHOOK_SIGNING_SECRET_<REF>); refusing to send unsigned.`,
    );
  }
  return value;
}

export function normalizeWebhookPayload(raw: unknown): NormalizedWebhook {
  // Task-contract alias: inline `signatureSecret`. strictObject would strip it,
  // so capture it before validation; it takes precedence over a ref.
  let inlineSecret: unknown;
  let toValidate: unknown = raw;
  if (raw !== null && typeof raw === 'object' && 'signatureSecret' in raw) {
    inlineSecret = (raw as Record<string, unknown>).signatureSecret;
    // Strip the inline secret before schema validation (it is resolved
    // separately); copy-then-delete keeps the caller's object untouched.
    const rest = { ...(raw as Record<string, unknown>) };
    delete rest.signatureSecret;
    toValidate = rest;
  }
  const parsed = WebhookPayloadSchema.safeParse(toValidate);
  if (!parsed.success) {
    WebhookPayloadSchema.parse(toValidate); // throws ZodError (non-retryable)
    throw new Error('unreachable');
  }
  const p = parsed.data;
  // Scheme allowlist at normalization time (zod .url() accepts ftp: etc.).
  // The SSRF guard re-checks this before any network I/O.
  if (p.url.startsWith('ftp:') || (!p.url.startsWith('http://') && !p.url.startsWith('https://'))) {
    failValidation(`webhook url scheme not allowed (http/https only): ${p.url.slice(0, 32)}`);
  }
  const headers: Record<string, string> = { ...(p.headers ?? {}) };
  // Never allow caller-supplied signature headers to spoof ours.
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'x-pravshi-signature' || lower === WEBHOOK_TIMESTAMP_HEADER) delete headers[k];
  }
  const signatureSecret =
    typeof inlineSecret === 'string' && inlineSecret.length > 0
      ? inlineSecret
      : resolveWebhookSecretRef(p.signatureSecretRef);
  return {
    url: p.url,
    method: p.method,
    headers,
    body: serializeWebhookBody(p.body),
    signatureSecret,
    timeoutMs: p.timeoutMs,
    subscriptionId: p.subscriptionId,
    deliveryId: p.deliveryId,
  };
}

/**
 * Phase 10 (Wave W-out): resolve an org subscription's signing secret on
 * the worker plane. The payload carries only the subscriptionId (§4.5
 * [DECISION] — secrets never ride in jobs.payload); the org comes from
 * the JOB ROW (ctx.job.orgId, §3.6), never from the payload.
 *
 * The worker runs as the nil-UUID system actor, which cannot satisfy the
 * subscriptions SELECT policy (integrations.view), so the read goes
 * through the bounded SECURITY DEFINER from migration 0059 —
 * integration_webhook_resolve_delivery(org, subscription) — the
 * notifications_insert / notifications_recipient_exists pattern. It
 * returns the row's active flag and signing-secret CIPHERTEXT only;
 * decryption happens here, with the env-held vault key, and the
 * plaintext exists only for the duration of the send.
 *
 * Returns the plaintext secret, or null when the subscription was
 * disabled after enqueue (the delivery is dropped, not attempted — a
 * state the admin chose, so the job completes). Missing/cross-org →
 * NOT_FOUND; an active subscription without a readable secret →
 * CONFIG_ERROR (refusing to send unsigned, the env-ref doctrine).
 */
async function resolveSubscriptionSigningSecret(
  ctx: JobExecutionContext,
  subscriptionId: string,
): Promise<string | null> {
  const orgId = ctx.job.orgId;
  const rows = await withAuthorizedDb(ctx.auth.ctx, (tx) =>
    tx.execute<{ is_active: boolean; signing_secret_ciphertext: string | null }>(sql`
      select r.is_active, r.signing_secret_ciphertext
      from public.integration_webhook_resolve_delivery(
        ${orgId}::uuid,
        ${subscriptionId}::uuid
      ) as r
    `),
  );
  const row = rows.rows[0];
  if (!row) {
    failNotFound(`webhook subscription ${subscriptionId} not found in org ${orgId}`);
  }
  if (!row.is_active) return null;
  if (row.signing_secret_ciphertext === null) {
    failConfig(
      `webhook subscription ${subscriptionId} has no signing secret configured; ` +
        'refusing to send unsigned.',
    );
  }
  try {
    return decryptSecret(row.signing_secret_ciphertext as string);
  } catch (error) {
    if (error instanceof IntegrationsVaultError) {
      // VAULT_NOT_CONFIGURED (key unset) and DECRYPT_FAILED (tampered /
      // wrong key) alike: retrying this job cannot fix deployment state,
      // and sending unsigned is never an option — CONFIG_ERROR, and the
      // static message carries no ciphertext or key material.
      failConfig(
        `webhook subscription ${subscriptionId} signing secret could not be resolved ` +
          `(${error.code}); refusing to send unsigned.`,
      );
    }
    throw error;
  }
}

/**
 * `webhook` job → SSRF-guarded outbound HTTP request.
 * - Only http/https; private/loopback/link-local/metadata IPs blocked
 *   (literal AND resolved); .internal/.localhost hostnames blocked.
 * - 10s default timeout (payload-overridable 1–30s), 1 MiB response cap,
 *   max 2 redirects (each hop re-validated).
 * - HMAC-SHA256 signature header when a secret is configured (never logged).
 * - Non-2xx: 4xx → non-retryable, 5xx → retryable (via classifyError on
 *   the attached statusCode).
 * - Phase 10: a payload carrying `subscriptionId` is an org subscription
 *   delivery — its signing secret is resolved + decrypted inside the
 *   worker (resolveSubscriptionSigningSecret) and takes precedence over
 *   any env-ref; a subscription disabled after enqueue drops the delivery
 *   (job succeeds, nothing is sent). Deployment-level payloads (env-ref
 *   or inline secret, no subscriptionId) behave exactly as before.
 */
export const handleWebhook: JobHandler = async (ctx: JobExecutionContext) => {
  const rawSubscriptionId = ctx.job.payload['subscriptionId'];
  let w: NormalizedWebhook;
  if (typeof rawSubscriptionId === 'string' && rawSubscriptionId.length > 0) {
    const subscriptionSecret = await resolveSubscriptionSigningSecret(ctx, rawSubscriptionId);
    if (subscriptionSecret === null) {
      console.info(
        `[jobs] webhook dropped job=${ctx.job.id} subscription=${rawSubscriptionId} ` +
          'reason=subscription_disabled',
      );
      return;
    }
    // Inject as the inline-secret alias: normalizeWebhookPayload gives it
    // precedence over any signatureSecretRef, and strips it before the
    // schema parse — the plaintext never lands in the stored payload.
    w = normalizeWebhookPayload({ ...ctx.job.payload, signatureSecret: subscriptionSecret });
  } else {
    w = normalizeWebhookPayload(ctx.job.payload);
  }

  const headers: Record<string, string> = { ...w.headers };
  const hasHeader = (name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (w.body.length > 0 && !hasHeader('content-type')) {
    headers['content-type'] = 'application/json';
  }
  if (w.signatureSecret) {
    headers['x-pravshi-signature'] = signWebhookBody(w.body, w.signatureSecret);
  }
  headers[WEBHOOK_TIMESTAMP_HEADER] = String(Math.floor(Date.now() / 1000));
  headers['x-pravshi-webhook-id'] = ctx.job.id;

  let current = await assertWebhookTargetAllowed(w.url);
  let method: string = w.method;
  let body = w.body;
  let redirects = 0;

  for (;;) {
    let result: WebhookFetchResult;
    try {
      result = await fetchWebhookPinned(current.url, {
        method,
        headers,
        body,
        timeoutMs: w.timeoutMs,
        pinnedIp: current.pinnedIp,
        pinnedFamily: current.pinnedFamily,
        signal: ctx.signal,
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes('UPSTREAM_RESPONSE_TOO_LARGE')) {
        // Remote consistently returns >1 MiB; retrying won't help.
        jobFail('UPSTREAM_RESPONSE_TOO_LARGE', 'webhook response exceeded 1 MiB cap');
      }
      if (/timed?\s?out/i.test(msg)) {
        const timeoutErr = new Error(`webhook timed out after ${w.timeoutMs}ms`) as CodedError;
        timeoutErr.code = 'ETIMEDOUT'; // → retryable via classifyError
        throw timeoutErr;
      }
      throw err; // fail-open: unknown transport errors retry
    }

    const outcome = classifyWebhookStatus(result.status);

    if (outcome === 'ok') {
      console.info(
        `[jobs] webhook ok job=${ctx.job.id} status=${result.status} ` +
          `bytes=${result.bytes} redirects=${redirects} signed=${w.signatureSecret !== undefined}`,
      );
      return;
    }

    // Redirects: follow at most WEBHOOK_MAX_REDIRECTS hops. Every hop is
    // re-validated through the full SSRF gate (static + DNS + pin) — a
    // redirect to a private IP is blocked, not followed.
    if (result.status >= 300 && result.status < 400 && redirects < WEBHOOK_MAX_REDIRECTS) {
      const location = result.headers['location'];
      const locationStr = Array.isArray(location) ? location[0] : location;
      if (typeof locationStr === 'string' && locationStr.length > 0) {
        const nextUrl = new URL(locationStr, current.url).toString();
        current = await assertWebhookTargetAllowed(nextUrl); // throws → non-retryable
        redirects += 1;
        if (result.status === 307 || result.status === 308) {
          // Preserve method + body; the signature still covers the same body.
        } else {
          // 301/302/303: per fetch semantics, downgrade to GET without body.
          method = 'GET';
          body = Buffer.alloc(0);
          for (const k of Object.keys(headers)) {
            const lower = k.toLowerCase();
            if (lower === 'content-type' || lower === 'x-pravshi-signature') delete headers[k];
          }
        }
        continue;
      }
    }

    if (outcome === 'client-error') {
      jobFail(`HTTP_${result.status}`, `webhook failed with client error ${result.status}`, {
        statusCode: result.status, // classifyError → non-retryable
      });
    }
    // server-error, redirect budget exhausted, or 3xx without a Location.
    jobFail(`HTTP_${result.status}`, `webhook failed with status ${result.status}`, {
      statusCode: result.status, // 5xx → retryable; anything else → fail-open retryable
    });
  }
};

// ── 4. CLEANUP ────────────────────────────────────────────────────────────────

/**
 * Terminal states per contract §3.1 (no outgoing transitions).
 * `dead_letter` is deliberately EXCLUDED: it is the human review queue and
 * supports manual replay (dead_letter → pending), so retention deletion must
 * not silently discard it. `failed` is non-terminal (retryable) and is never
 * deleted either. (The cleanup queries below inline these two literals.)
 */

export const CLEANUP_TARGETS = ['stale_jobs', 'expired_leases'] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

/** Default retention for terminal jobs: 90 days (task contract). */
export const DEFAULT_RETENTION_DAYS = 90;
/** Default staleness threshold for claimed/running leases without heartbeat. */
export const DEFAULT_LEASE_STALE_MS = 5 * 60 * 1000;

export interface NormalizedCleanup {
  target: CleanupTarget;
  olderThanDays: number;
  dryRun: boolean;
  staleThresholdMs: number;
}

export function normalizeCleanupPayload(raw: unknown): NormalizedCleanup {
  const parsed = CleanupPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    CleanupPayloadSchema.parse(raw); // throws ZodError (non-retryable)
    throw new Error('unreachable');
  }
  const p = parsed.data;
  if (!CLEANUP_TARGETS.includes(p.target as CleanupTarget)) {
    failValidation(
      `unknown cleanup target '${p.target}'; expected one of: ${CLEANUP_TARGETS.join(', ')}`,
    );
  }
  const params = p.params ?? {};
  const staleThresholdMs =
    typeof params.staleThresholdMs === 'number' &&
    Number.isFinite(params.staleThresholdMs) &&
    params.staleThresholdMs >= 1000
      ? Math.floor(params.staleThresholdMs)
      : DEFAULT_LEASE_STALE_MS;
  return {
    target: p.target as CleanupTarget,
    olderThanDays: p.olderThanDays ?? DEFAULT_RETENTION_DAYS,
    dryRun: p.dryRun,
    staleThresholdMs,
  };
}

async function cleanupStaleJobs(
  auth: Authorization,
  orgId: string,
  c: NormalizedCleanup,
): Promise<number> {
  const cutoff = new Date(Date.now() - c.olderThanDays * 86_400_000).toISOString();
  if (c.dryRun) {
    const rows = await withAuthorizedDb(auth.ctx, (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from public.jobs
            where org_id = ${orgId}::uuid
              and status in ('succeeded', 'cancelled')
              and created_at < ${cutoff}::timestamptz`,
      ),
    );
    return Number(rows.rows[0]?.n ?? 0);
  }
  // ONLY terminal states — the status list is a literal, never from payload.
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ n: string }>(
      sql`with deleted as (
             delete from public.jobs
             where org_id = ${orgId}::uuid
               and status in ('succeeded', 'cancelled')
               and created_at < ${cutoff}::timestamptz
             returning id
           )
           select count(*)::text as n from deleted`,
    ),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/**
 * Reset stale claimed/running leases: heartbeat (or claim time when no
 * heartbeat yet) older than the threshold → back to pending with attempts+1.
 * Both claimed→pending and running→pending are legal §3.1 transitions.
 * This mirrors the worker-plane reapStaleJobs() (worker.ts, contract §3.4);
 * the worker's reaper covers crash recovery at startup, this job covers
 * steady-state lease expiry per org.
 */
async function cleanupExpiredLeases(
  auth: Authorization,
  orgId: string,
  c: NormalizedCleanup,
): Promise<number> {
  const cutoff = new Date(Date.now() - c.staleThresholdMs).toISOString();
  if (c.dryRun) {
    const rows = await withAuthorizedDb(auth.ctx, (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from public.jobs
            where org_id = ${orgId}::uuid
              and status in ('claimed', 'running')
              and coalesce(heartbeat_at, claimed_at) < ${cutoff}::timestamptz`,
      ),
    );
    return Number(rows.rows[0]?.n ?? 0);
  }
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ n: string }>(
      sql`with reset as (
             update public.jobs
             set status = 'pending',
                 attempts = attempts + 1,
                 claimed_by = null,
                 claimed_at = null,
                 heartbeat_at = null,
                 error_code = 'LEASE_EXPIRED',
                 error_message = 'lease expired: no heartbeat; reset to pending by cleanup job',
                 updated_at = now()
             where org_id = ${orgId}::uuid
               and status in ('claimed', 'running')
               and coalesce(heartbeat_at, claimed_at) < ${cutoff}::timestamptz
             returning id
           )
           select count(*)::text as n from reset`,
    ),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/**
 * `cleanup` job → retention / lease housekeeping, scoped to the job's org.
 * - target 'stale_jobs': delete terminal (succeeded/cancelled) jobs older
 *   than olderThanDays (default 90). NEVER touches non-terminal jobs.
 * - target 'expired_leases': reset claimed/running jobs whose heartbeat is
 *   older than staleThresholdMs (default 5 min) back to pending.
 * - dryRun: count only, change nothing.
 */
export const handleCleanup: JobHandler = async (ctx: JobExecutionContext) => {
  const orgId = ctx.job.orgId;
  const c = normalizeCleanupPayload(ctx.job.payload);

  const count =
    c.target === 'stale_jobs'
      ? await cleanupStaleJobs(ctx.auth, orgId, c)
      : await cleanupExpiredLeases(ctx.auth, orgId, c);

  console.info(
    `[jobs] cleanup job=${ctx.job.id} org=${orgId} target=${c.target} ` +
      `affected=${count} dry_run=${c.dryRun}`,
  );
};

// ── Registration (contract §3.4 — registerHandler is owned by worker.ts) ─────

registerHandler('notification', handleNotification);
registerHandler('webhook', handleWebhook);
registerHandler('email', handleEmail);
registerHandler('cleanup', handleCleanup);
