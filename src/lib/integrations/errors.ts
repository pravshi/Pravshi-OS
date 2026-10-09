import { z } from 'zod';
import {
  IntegrationsVaultError,
  isIntegrationsVaultError,
  type VaultEnvelope,
  type VaultErrorCode,
} from './secrets';

/**
 * Normalized integrations error taxonomy — Phase 10 contract §4.3/§4.4,
 * modelled on the Phase 9 AI taxonomy (src/lib/ai/errors.ts) and the §24
 * envelope codes in src/lib/authz/errors.ts.
 *
 * Route handlers (Wave G) see exactly ONE integrations taxonomy: this class.
 * The Wave K vault error (IntegrationsVaultError) is mapped into it by
 * `fromVaultError` so no route ever branches on vault internals; the vault
 * symbols are also re-exported here for waves that legitimately work at the
 * vault layer (Wave W-out's handler-side secret resolution).
 *
 * Every message in this file is STATIC. Nothing here may interpolate a
 * provider response, a config value, a credential, ciphertext or a nonce
 * (§4.3 redaction rules) — a caller learns which class of thing happened and
 * nothing else.
 *
 * ── THE CODES ──────────────────────────────────────────────────────────────
 *
 *   NOT_FOUND              404  the connection is not visible — missing, or
 *                               another tenant's (concealment, §4.7: answering
 *                               "exists but not yours" is itself the leak).
 *                               Id-addressed reads/mutations in the service
 *                               usually surface this via assertTargetAffected
 *                               (AuthorizationError, the CRM pattern); this
 *                               code covers the service paths that are not
 *                               mediated by it.
 *   FORBIDDEN              403  a service-level refusal distinct from the
 *                               route's withPermission gate — e.g. an
 *                               operation the caller's authorization class
 *                               may never perform regardless of role grants.
 *   VALIDATION             400  malformed or impermissible input: unknown
 *                               provider key, config failing the provider's
 *                               schema, a credential-shaped key inside
 *                               config, an identity column in an update.
 *   CONFLICT               409  the request collides with existing state —
 *                               a second connection for a singleton provider.
 *   NOT_CONFIGURED        503  a required piece of deployment configuration
 *                               is absent — the Tier V vault key is unset
 *                               (VAULT_NOT_CONFIGURED maps here), so the
 *                               operation cannot be performed at all. The
 *                               app and every Tier E feature keep working.
 *   CREDENTIAL_UNREADABLE  500  a stored vault credential cannot be
 *                               decrypted (tampered envelope, unsupported
 *                               key version, wrong key). Never the caller's
 *                               fault and never retryable as-is; the static
 *                               message deliberately does not say which.
 */

export type IntegrationsErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_CONFIGURED'
  | 'CREDENTIAL_UNREADABLE';

const STATUS_BY_CODE: Readonly<Record<IntegrationsErrorCode, number>> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_CONFIGURED: 503,
  CREDENTIAL_UNREADABLE: 500,
};

const MESSAGE_BY_CODE: Readonly<Record<IntegrationsErrorCode, string>> = {
  NOT_FOUND: 'Integration connection not found.',
  FORBIDDEN: 'You do not have access to this integration operation.',
  VALIDATION: 'The integration request is invalid.',
  CONFLICT: 'An integration connection already exists for this provider.',
  NOT_CONFIGURED: 'This integration is not configured.',
  CREDENTIAL_UNREADABLE: 'The stored credential could not be read.',
};

export class IntegrationsError extends Error {
  readonly code: IntegrationsErrorCode;
  /** HTTP status Wave G routes answer with (see http.ts). */
  readonly status: number;
  /**
   * Optional safe detail appended after the static message — a FIELD PATH or
   * a provider KEY only, never a value (callers in this module uphold it;
   * the constructor refuses anything that is not a short identifier-shaped
   * string by simply not being given one anywhere else).
   */
  readonly detail: string | null;

  /**
   * `messageOverride`, when given, replaces the per-code default message.
   * It exists for codes shared by several operations whose default text is
   * operation-specific (CONFLICT is the case today: the default speaks of
   * connections, the subscription delete needs its own sentence). Callers
   * pass STATIC string literals only — the no-interpolation rule above is
   * not relaxed by this parameter.
   */
  constructor(code: IntegrationsErrorCode, detail?: string, messageOverride?: string) {
    super(
      messageOverride ?? (detail ? `${MESSAGE_BY_CODE[code]} (${detail})` : MESSAGE_BY_CODE[code]),
    );
    this.name = 'IntegrationsError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.detail = detail ?? null;
  }
}

export function isIntegrationsError(value: unknown): value is IntegrationsError {
  return value instanceof IntegrationsError;
}

/* ── Shared id validation (the service-layer half of Finding 1) ────────── */

/**
 * The module's ONE uuid shape, shared by every layer that checks an id:
 * http.ts's route guard (parseIntegrationId) parses this schema and lets
 * the ZodError fly — routes map that to 400 INVALID_REQUEST. The service
 * layer must never let a malformed id reach a `${id}::uuid` cast instead:
 * Postgres would raise 22P02, which is neither typed nor mapped and so
 * escapes as an opaque 500 (Wave J Finding 1). Services run every id
 * argument through assertIntegrationUuid BEFORE any SQL runs, and a
 * malformed id fails fast as the typed VALIDATION (detail = the
 * argument's field name only, per the taxonomy's no-values rule).
 */
export const IntegrationUuidSchema = z.string().uuid();

/** Throws IntegrationsError VALIDATION when `value` is not a uuid. */
export function assertIntegrationUuid(value: string, field: string): void {
  if (!IntegrationUuidSchema.safeParse(value).success) {
    throw new IntegrationsError('VALIDATION', field);
  }
}

const INTEGRATIONS_CODE_BY_VAULT_CODE: Readonly<Record<VaultErrorCode, IntegrationsErrorCode>> = {
  VAULT_NOT_CONFIGURED: 'NOT_CONFIGURED',
  VAULT_MALFORMED_ENVELOPE: 'CREDENTIAL_UNREADABLE',
  VAULT_UNSUPPORTED_KEY_VERSION: 'CREDENTIAL_UNREADABLE',
  VAULT_DECRYPT_FAILED: 'CREDENTIAL_UNREADABLE',
};

/**
 * The single bridge from the vault layer into this taxonomy. Non-vault values
 * pass through unchanged so callers can wrap a whole operation:
 * `catch (e) { throw fromVaultError(e) }` never swallows a foreign error.
 */
export function fromVaultError(value: unknown): unknown {
  if (value instanceof IntegrationsVaultError) {
    return new IntegrationsError(INTEGRATIONS_CODE_BY_VAULT_CODE[value.code]);
  }
  return value;
}

/** Throwing form of fromVaultError for vault call sites in the service. */
export function rethrowAsIntegrationsError(value: unknown): never {
  throw fromVaultError(value);
}

export { IntegrationsVaultError, isIntegrationsVaultError };
export type { VaultEnvelope, VaultErrorCode };
