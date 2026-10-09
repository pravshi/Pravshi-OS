import { z } from 'zod';
import type { IntegrationProviderDefinition } from './types';

/**
 * Email via Resend — Phase 10 contract §4.6 item 1.
 *
 * The deployment-level sending credential already exists: the Phase 6 job
 * email handler reads EMAIL_PROVIDER / EMAIL_PROVIDER_API_KEY, and Better
 * Auth's mail flows use RESEND_API_KEY / EMAIL_FROM. This provider is
 * therefore Tier E (§4.3): a connection stores only `credential_ref` naming
 * EMAIL_PROVIDER_API_KEY — the jobs-path credential Wave P's adapter will
 * send through — and never a pasted secret. Singleton: an org has exactly
 * one sending identity in V1.
 *
 * The non-secret config is the org's sending identity. All fields optional:
 * a connection may exist (NOT_CONFIGURED) before the org chooses them, and
 * Wave P's adapter composes them with the deployment's EMAIL_FROM fallback.
 */
export const EmailConfigSchema = z.strictObject({
  /** From address on the org's verified sending domain. */
  fromAddress: z.string().email().max(254).optional(),
  /** Display name paired with fromAddress. */
  fromName: z.string().min(1).max(120).optional(),
  /** Default reply-to for org-sent mail. */
  replyTo: z.string().email().max(254).optional(),
});

export const emailProvider: IntegrationProviderDefinition = {
  key: 'email',
  displayName: 'Email',
  description:
    'Outbound email via Resend, sent through the Phase 6 job queue ' +
    '(workflow send_email actions and system mail).',
  singleton: true,
  credentialTier: 'env',
  credentialRefEnvVar: 'EMAIL_PROVIDER_API_KEY',
  configSchema: EmailConfigSchema,
  defaultConfig: {},
  capabilities: ['email'],
  healthCheck: {
    kind: 'config',
    description:
      'Healthy when the deployment email credential referenced by the ' +
      'connection is present; Wave P adds the live send-path signal.',
  },
  inbound: null,
};
