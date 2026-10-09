import type {
  IntegrationConnectionSummary,
  IntegrationConnectionStatus,
} from '@/lib/integrations/connections';
import type { IntegrationExecution } from '@/lib/integrations/executions';
import type { WebhookSubscriptionSummary } from '@/lib/integrations/subscriptions';

/**
 * integrations-client — browser-side client for /api/integrations/*
 * (Phase 10, Wave G), mirroring the ai-client.ts pattern: an
 * envelope-aware fetch wrapper plus the pure shaping logic the settings
 * UI renders from.
 *
 * The server enforces everything: authentication (401), the
 * integrations.view / integrations.manage gates (403), tenant
 * concealment (404 NOT_FOUND), input validation (400), and the typed
 * integrations taxonomy (409 CONFLICT, 503 NOT_CONFIGURED, 500
 * CREDENTIAL_UNREADABLE). The UI renders exactly what this returns.
 *
 * Secrets discipline (§4.3): request bodies built here carry a Tier V
 * secret exactly once, in memory, at submit time. Responses never
 * contain one — except the two dedicated once-only shapes
 * (SubscriptionSecretWire, IssuedInboundEndpointWire), which the UI
 * holds in component state for a single display and drops on dismiss.
 * Nothing is persisted (no localStorage/sessionStorage).
 */

/* ── Wire shapes (the JSON the routes answer with) ───────────────────────── */

export interface IntegrationConnectionWire {
  readonly id: string;
  readonly providerKey: string;
  readonly displayName: string;
  readonly status: IntegrationConnectionStatus;
  readonly config: Readonly<Record<string, unknown>>;
  readonly hasCredential: boolean;
  readonly maskedCredentialRef: string | null;
  readonly connectedBy: string | null;
  readonly lastHealthAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntegrationProviderWire {
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  readonly singleton: boolean;
  readonly credentialTier: 'env' | 'vault';
  readonly credentialRefEnvVar: string | null;
  readonly capabilities: readonly string[];
  readonly healthCheck: { readonly kind: string; readonly description: string };
  readonly inbound: { readonly verification: string; readonly maxBodyBytes: number } | null;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly connections: readonly IntegrationConnectionWire[];
}

export interface IntegrationsOverviewWire {
  readonly vaultConfigured: boolean;
  readonly providers: readonly IntegrationProviderWire[];
}

export interface WebhookSubscriptionWire {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly hasSigningSecret: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookSubscriptionPageWire {
  readonly rows: readonly WebhookSubscriptionWire[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** The create/rotate response: the ONLY shape that ever carries a signing secret. */
export interface SubscriptionSecretWire {
  readonly subscription: WebhookSubscriptionWire;
  readonly signingSecret: string;
}

/** The inbound-endpoint issuance response: token + full URL, exactly once. */
export interface IssuedInboundEndpointWire {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly endpointKey: string;
  readonly inboundUrl: string;
}

export interface IntegrationExecutionWire {
  readonly id: string;
  readonly kind: 'webhook_delivery' | 'email' | 'inbound_event';
  readonly status: string;
  readonly providerKey: string | null;
  readonly eventKey: string | null;
  readonly subscriptionId: string | null;
  readonly connectionId: string | null;
  readonly jobId: string | null;
  readonly targetUrl: string | null;
  readonly errorCode: string | null;
  readonly attempts: number | null;
  readonly occurredAt: string;
  readonly updatedAt: string | null;
}

export interface IntegrationExecutionPageWire {
  readonly rows: readonly IntegrationExecutionWire[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/* ── Service DTO → wire (used by the server page for initial data) ────────── */

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toConnectionWire(summary: IntegrationConnectionSummary): IntegrationConnectionWire {
  return {
    id: summary.id,
    providerKey: summary.providerKey,
    displayName: summary.displayName,
    status: summary.status,
    config: summary.config,
    hasCredential: summary.hasCredential,
    maskedCredentialRef: summary.maskedCredentialRef,
    connectedBy: summary.connectedBy,
    lastHealthAt: summary.lastHealthAt === null ? null : iso(summary.lastHealthAt),
    lastErrorCode: summary.lastErrorCode,
    createdAt: iso(summary.createdAt),
    updatedAt: iso(summary.updatedAt),
  };
}

export function toSubscriptionWire(summary: WebhookSubscriptionSummary): WebhookSubscriptionWire {
  return {
    id: summary.id,
    url: summary.url,
    events: summary.events,
    active: summary.active,
    hasSigningSecret: summary.hasSigningSecret,
    createdBy: summary.createdBy,
    createdAt: iso(summary.createdAt),
    updatedAt: iso(summary.updatedAt),
  };
}

export function toExecutionWire(execution: IntegrationExecution): IntegrationExecutionWire {
  return {
    id: execution.id,
    kind: execution.kind,
    status: execution.status,
    providerKey: execution.providerKey,
    eventKey: execution.eventKey,
    subscriptionId: execution.subscriptionId,
    connectionId: execution.connectionId,
    jobId: execution.jobId,
    targetUrl: execution.targetUrl,
    errorCode: execution.errorCode,
    attempts: execution.attempts,
    occurredAt: iso(execution.occurredAt),
    updatedAt: execution.updatedAt === null ? null : iso(execution.updatedAt),
  };
}

/* ── Errors ──────────────────────────────────────────────────────────────── */

export type IntegrationsApiErrorCode =
  | 'INVALID_REQUEST'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'NOT_CONFIGURED'
  | 'CREDENTIAL_UNREADABLE'
  | 'UNAUTHORIZED'
  | 'REQUEST_FAILED'
  | 'SERVER_ERROR';

export class IntegrationsApiError extends Error {
  readonly code: IntegrationsApiErrorCode;
  readonly status: number;

  constructor(code: IntegrationsApiErrorCode, status: number, message: string) {
    super(message);
    this.name = 'IntegrationsApiError';
    this.code = code;
    this.status = status;
  }
}

interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
}

/** Reads the §24 envelope ({ error: { code, message } }). */
function parseErrorEnvelope(body: unknown): ErrorEnvelope {
  if (typeof body !== 'object' || body === null) return {};
  const record = body as { error?: unknown };
  if (typeof record.error === 'object' && record.error !== null) {
    const inner = record.error as { code?: unknown; message?: unknown };
    return {
      code: typeof inner.code === 'string' ? inner.code : undefined,
      message: typeof inner.message === 'string' ? inner.message : undefined,
    };
  }
  return {};
}

const ENVELOPE_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'VALIDATION',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'NOT_CONFIGURED',
  'CREDENTIAL_UNREADABLE',
]);

function errorForStatus(
  status: number,
  envelope: ErrorEnvelope,
): { code: IntegrationsApiErrorCode; message: string } {
  const detail = envelope.message;
  switch (status) {
    case 400:
      return { code: 'VALIDATION', message: detail || 'The request was invalid.' };
    case 401:
      return {
        code: 'UNAUTHORIZED',
        message: 'Your session has expired. Sign in again to manage integrations.',
      };
    case 403:
      return {
        code: 'FORBIDDEN',
        message: detail || 'You do not have access to this integration operation.',
      };
    case 404:
      return { code: 'NOT_FOUND', message: detail || 'That integration could not be found.' };
    case 409:
      return {
        code: 'CONFLICT',
        message: detail || 'A connection already exists for this provider.',
      };
    case 503:
      return {
        code: 'NOT_CONFIGURED',
        message: detail || 'This integration is not configured on the server.',
      };
    default:
      return {
        code: 'SERVER_ERROR',
        message: detail || 'Integrations are temporarily unavailable. Please try again.',
      };
  }
}

/* ── Fetch plumbing ──────────────────────────────────────────────────────── */

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init?.headers },
    });
  } catch {
    throw new IntegrationsApiError(
      'REQUEST_FAILED',
      0,
      'Could not reach the integrations service.',
    );
  }
  if (response.ok) {
    return (await response.json()) as T;
  }
  let envelope: ErrorEnvelope = {};
  try {
    envelope = parseErrorEnvelope(await response.json());
  } catch {
    // Non-JSON error body; fall through to the status-based messages.
  }
  const mapped = errorForStatus(response.status, envelope);
  const code =
    envelope.code !== undefined && ENVELOPE_CODES.has(envelope.code)
      ? (envelope.code as IntegrationsApiErrorCode)
      : mapped.code;
  throw new IntegrationsApiError(code, response.status, mapped.message);
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

/* ── API calls ───────────────────────────────────────────────────────────── */

export function fetchIntegrationsOverview(): Promise<IntegrationsOverviewWire> {
  return apiFetch<IntegrationsOverviewWire>('/api/integrations');
}

export function createConnection(body: CreateConnectionBody): Promise<IntegrationConnectionWire> {
  return apiFetch<IntegrationConnectionWire>('/api/integrations/connections', jsonBody(body));
}

export function updateConnection(
  id: string,
  body: UpdateConnectionBody,
): Promise<IntegrationConnectionWire> {
  return apiFetch<IntegrationConnectionWire>(`/api/integrations/connections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function disconnectConnection(id: string): Promise<{ disconnected: true }> {
  return apiFetch<{ disconnected: true }>(`/api/integrations/connections/${id}`, {
    method: 'DELETE',
  });
}

export function rotateConnectionSecret(
  id: string,
  body: RotateConnectionSecretBody,
): Promise<IntegrationConnectionWire> {
  return apiFetch<IntegrationConnectionWire>(
    `/api/integrations/connections/${id}/rotate-secret`,
    jsonBody(body),
  );
}

export function issueInboundEndpoint(connectionId: string): Promise<IssuedInboundEndpointWire> {
  return apiFetch<IssuedInboundEndpointWire>(
    `/api/integrations/connections/${connectionId}/inbound-endpoint`,
    { method: 'POST' },
  );
}

export function fetchSubscriptions(active?: boolean): Promise<WebhookSubscriptionPageWire> {
  const query = active === undefined ? '' : `?active=${active ? 'true' : 'false'}`;
  return apiFetch<WebhookSubscriptionPageWire>(`/api/integrations/webhooks${query}`);
}

export function createSubscription(body: {
  url: string;
  events: string[];
}): Promise<SubscriptionSecretWire> {
  return apiFetch<SubscriptionSecretWire>('/api/integrations/webhooks', jsonBody(body));
}

export function updateSubscription(
  id: string,
  body: UpdateSubscriptionBody,
): Promise<WebhookSubscriptionWire> {
  return apiFetch<WebhookSubscriptionWire>(`/api/integrations/webhooks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteSubscription(id: string): Promise<{ deleted: true }> {
  return apiFetch<{ deleted: true }>(`/api/integrations/webhooks/${id}`, { method: 'DELETE' });
}

export function rotateSubscriptionSecret(id: string): Promise<SubscriptionSecretWire> {
  return apiFetch<SubscriptionSecretWire>(`/api/integrations/webhooks/${id}/rotate-secret`, {
    method: 'POST',
  });
}

export function fetchExecutions(
  kind?: IntegrationExecutionWire['kind'],
): Promise<IntegrationExecutionPageWire> {
  const query = kind === undefined ? '' : `?kind=${kind}`;
  return apiFetch<IntegrationExecutionPageWire>(`/api/integrations/executions${query}`);
}

/* ── Request body builders (pure; the forms' submit logic) ───────────────── */

export interface ConnectionFormValues {
  readonly displayName: string;
  /** Raw form values by config key; blank strings mean "not provided". */
  readonly configValues: Readonly<Record<string, string | boolean>>;
  /** Tier V secret from the write-only field; '' when untouched. */
  readonly secret: string;
}

export interface CreateConnectionBody {
  readonly providerKey: string;
  readonly displayName: string;
  readonly config?: Record<string, unknown>;
  readonly secret?: string;
}

export interface UpdateConnectionBody {
  readonly displayName?: string;
  readonly config?: Record<string, unknown>;
  readonly status?: IntegrationConnectionStatus;
}

export interface RotateConnectionSecretBody {
  readonly secret?: string;
  readonly credentialRef?: string;
}

export interface UpdateSubscriptionBody {
  readonly url?: string;
  readonly events?: string[];
  readonly active?: boolean;
}

/**
 * Cleans raw form config values into a service-ready config object:
 * blank strings are dropped (an untouched optional field must not reach
 * the provider schema as ''), booleans pass through, other strings are
 * trimmed.
 */
export function cleanConfigValues(
  values: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'boolean') {
      config[key] = value;
    } else {
      const trimmed = value.trim();
      if (trimmed.length > 0) config[key] = trimmed;
    }
  }
  return config;
}

/** The create body for a connection: the secret rides only when one was typed. */
export function buildCreateConnectionBody(
  providerKey: string,
  values: ConnectionFormValues,
): CreateConnectionBody {
  const config = cleanConfigValues(values.configValues);
  return {
    providerKey,
    displayName: values.displayName.trim(),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(values.secret.length > 0 ? { secret: values.secret } : {}),
  };
}

/**
 * The update body for a connection edit: only fields that actually
 * changed. Returns null when nothing changed (the form disables submit
 * — the service also rejects an empty update as VALIDATION).
 */
export function buildUpdateConnectionBody(
  original: IntegrationConnectionWire,
  values: ConnectionFormValues,
): UpdateConnectionBody | null {
  const displayName = values.displayName.trim();
  const config = cleanConfigValues(values.configValues);
  const changed: { displayName?: string; config?: Record<string, unknown> } = {
    ...(displayName !== original.displayName ? { displayName } : {}),
    ...(JSON.stringify(config) !== JSON.stringify(original.config) ? { config } : {}),
  };
  return Object.keys(changed).length > 0 ? changed : null;
}

/** Toggles one event key in a subscription selection (order-stable). */
export function toggleEventSelection(
  selected: readonly string[],
  eventKey: string,
  on: boolean,
): string[] {
  if (on) return selected.includes(eventKey) ? [...selected] : [...selected, eventKey];
  return selected.filter((key) => key !== eventKey);
}

/* ── Display shaping (pure) ──────────────────────────────────────────────── */

export type StatusTone = 'success' | 'muted' | 'warning' | 'danger';

export function connectionStatusMeta(status: IntegrationConnectionStatus): {
  label: string;
  tone: StatusTone;
} {
  switch (status) {
    case 'CONNECTED':
      return { label: 'Connected', tone: 'success' };
    case 'DISCONNECTED':
      return { label: 'Disconnected', tone: 'muted' };
    case 'ERROR':
      return { label: 'Error', tone: 'danger' };
    case 'NOT_CONFIGURED':
      return { label: 'Not configured', tone: 'warning' };
  }
}

export function executionKindLabel(kind: IntegrationExecutionWire['kind']): string {
  switch (kind) {
    case 'webhook_delivery':
      return 'Webhook delivery';
    case 'email':
      return 'Email';
    case 'inbound_event':
      return 'Inbound event';
  }
}

/** Tone for a job/inbound status string in the executions table. */
export function executionStatusTone(status: string): StatusTone {
  switch (status) {
    case 'succeeded':
    case 'PROCESSED':
      return 'success';
    case 'failed':
    case 'dead_letter':
    case 'FAILED':
    case 'REJECTED_SIGNATURE':
    case 'REJECTED_VALIDATION':
      return 'danger';
    case 'pending':
    case 'claimed':
    case 'running':
    case 'RECEIVED':
      return 'warning';
    default:
      return 'muted';
  }
}

/**
 * Config form fields per provider (the V1 registry is code, so the form
 * shapes are code too). Keys must match the providers' zod config
 * schemas — the ui-logic suite pins that against the real registry.
 */
export interface ProviderConfigField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'email' | 'checkbox';
  readonly placeholder?: string;
}

export const PROVIDER_CONFIG_FIELDS: Readonly<Record<string, readonly ProviderConfigField[]>> = {
  email: [
    { key: 'fromAddress', label: 'From address', kind: 'email', placeholder: 'hello@example.com' },
    { key: 'fromName', label: 'From name', kind: 'text', placeholder: 'Pravshi' },
    {
      key: 'replyTo',
      label: 'Reply-to address',
      kind: 'email',
      placeholder: 'support@example.com',
    },
  ],
  webhooks: [
    { key: 'outboundEnabled', label: 'Outbound event fan-out enabled', kind: 'checkbox' },
    { key: 'inboundEnabled', label: 'Inbound receiver enabled', kind: 'checkbox' },
  ],
};

export function configFieldsForProvider(providerKey: string): readonly ProviderConfigField[] {
  return PROVIDER_CONFIG_FIELDS[providerKey] ?? [];
}

/* ── One-time secret display state (pure transitions) ────────────────────── */

/**
 * The state of a once-only secret reveal. The UI holds at most one at a
 * time; revealing a new one replaces the old (rotation invalidates it
 * anyway), and dismissing drops the plaintext from component state —
 * after that it exists nowhere in the browser.
 */
export interface RevealedSecret {
  readonly label: string;
  readonly secret: string;
  readonly hint: string;
}

export function revealSecret(label: string, secret: string, hint: string): RevealedSecret {
  return { label, secret, hint };
}

export function dismissSecret(): null {
  return null;
}
