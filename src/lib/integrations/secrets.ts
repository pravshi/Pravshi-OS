import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@/env';

/**
 * Credential vault — Phase 10 contract §4.3 (Tier V).
 *
 * Org-entered credentials (an admin pastes a provider secret into the UI) are
 * encrypted at rest with AES-256-GCM via `node:crypto` — no new dependency,
 * no KMS exists in this infrastructure (§2.8). The encryption key lives in the
 * deployment environment (`INTEGRATIONS_ENCRYPTION_KEY`, base64, 32 bytes);
 * the ciphertext lives in the database. The runtime necessarily holds both,
 * which is honestly a step below a KMS — the separation still means a database
 * dump alone, or an env leak alone, exposes no credential.
 *
 * The key is read ONLY through the parsed env (`src/env.ts`); this module
 * never touches `process.env`. When the key is unset or does not decode to
 * 32 bytes the vault is NOT_CONFIGURED: `isVaultConfigured()` returns false,
 * encrypt/decrypt throw the typed `VAULT_NOT_CONFIGURED` error, and the app
 * boots and runs normally without it (Tier E env-referenced credentials are
 * unaffected — see config.ts).
 *
 * ENVELOPE FORMAT (fixed by this file; §4.3's `key_version || nonce ||
 * ciphertext || tag`):
 *
 *   VaultEnvelope {
 *     keyVersion: number   — integer key version (V1: always 1)
 *     nonce:      string   — base64, 12 bytes, fresh per encryption
 *     ciphertext: string   — base64, AES-256-GCM ciphertext (may be empty)
 *     tag:        string   — base64, 16-byte GCM authentication tag
 *   }
 *
 *   Serialised (single-string) form:
 *     intg.v<keyVersion>.<base64 nonce>.<base64 ciphertext>.<base64 tag>
 *   ('.' never appears in the base64 alphabet, so it is a safe separator.)
 *
 *   Storage mapping (0056): keyVersion → `credential_key_version`,
 *   nonce → `credential_nonce`, ciphertext → `credential_ciphertext`; the
 *   envelope object (or its serialised form) is the unit the service layer
 *   passes around, so the tag is never separated from its ciphertext.
 *
 * Key rotation: V1 holds exactly one key (version 1). The version field makes
 * rotation auditable and lets a future per-version keyring extend this format
 * without a migration; decrypting an envelope of any other version fails with
 * VAULT_UNSUPPORTED_KEY_VERSION rather than silently using the wrong key.
 *
 * REDACTION RULES (§4.3): plaintext, ciphertext and nonce never appear in API
 * responses, logs, audit metadata or error messages. Every error message in
 * this file is static. `maskIdentifier`, `scrubText` and `redactForLog` below
 * are the helpers the service layer uses to keep it that way; they follow the
 * audit layer's precedent of treating credential-shaped keys as radioactive
 * (the write_audit_log backstop strips such keys — defence in depth, not a
 * substitute for never passing secrets in the first place).
 */

export type VaultErrorCode =
  | 'VAULT_NOT_CONFIGURED'
  | 'VAULT_MALFORMED_ENVELOPE'
  | 'VAULT_UNSUPPORTED_KEY_VERSION'
  | 'VAULT_DECRYPT_FAILED';

const MESSAGE_BY_CODE: Readonly<Record<VaultErrorCode, string>> = {
  VAULT_NOT_CONFIGURED: 'Integrations credential vault is not configured.',
  VAULT_MALFORMED_ENVELOPE: 'Stored credential envelope is malformed.',
  VAULT_UNSUPPORTED_KEY_VERSION: 'Stored credential uses an unsupported key version.',
  VAULT_DECRYPT_FAILED: 'Stored credential could not be decrypted.',
};

export class IntegrationsVaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.name = 'IntegrationsVaultError';
    this.code = code;
  }
}

export function isIntegrationsVaultError(value: unknown): value is IntegrationsVaultError {
  return value instanceof IntegrationsVaultError;
}

/** Raw env-shaped input; defaults to the parsed runtime env (the AI precedent). */
export interface VaultEnvSource {
  readonly INTEGRATIONS_ENCRYPTION_KEY?: string;
}

export interface VaultEnvelope {
  readonly keyVersion: number;
  /** base64, 12 bytes */
  readonly nonce: string;
  /** base64, AES-256-GCM ciphertext */
  readonly ciphertext: string;
  /** base64, 16 bytes */
  readonly tag: string;
}

export const VAULT_ALGORITHM = 'aes-256-gcm';
export const VAULT_KEY_BYTES = 32;
export const VAULT_NONCE_BYTES = 12;
export const VAULT_TAG_BYTES = 16;
export const CURRENT_KEY_VERSION = 1;

const ENVELOPE_PREFIX = 'intg';
const BASE64_SEGMENT = /^[A-Za-z0-9+/]*={0,2}$/;

function resolveKey(source: VaultEnvSource): Buffer | null {
  const raw = source.INTEGRATIONS_ENCRYPTION_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
  return key.length === VAULT_KEY_BYTES ? key : null;
}

export function isVaultConfigured(source: VaultEnvSource = env): boolean {
  return resolveKey(source) !== null;
}

function requireKey(source: VaultEnvSource): Buffer {
  const key = resolveKey(source);
  if (!key) throw new IntegrationsVaultError('VAULT_NOT_CONFIGURED');
  return key;
}

function decodeSegment(segment: string, expectedBytes: number | null): Buffer {
  if (!BASE64_SEGMENT.test(segment)) {
    throw new IntegrationsVaultError('VAULT_MALFORMED_ENVELOPE');
  }
  const decoded = Buffer.from(segment, 'base64');
  if (expectedBytes !== null && decoded.length !== expectedBytes) {
    throw new IntegrationsVaultError('VAULT_MALFORMED_ENVELOPE');
  }
  return decoded;
}

function normaliseEnvelope(envelope: VaultEnvelope): VaultEnvelope {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !Number.isInteger(envelope.keyVersion) ||
    envelope.keyVersion < 1 ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.tag !== 'string'
  ) {
    throw new IntegrationsVaultError('VAULT_MALFORMED_ENVELOPE');
  }
  // Validate the segments decode to the fixed sizes before any crypto runs.
  decodeSegment(envelope.nonce, VAULT_NONCE_BYTES);
  decodeSegment(envelope.ciphertext, null);
  decodeSegment(envelope.tag, VAULT_TAG_BYTES);
  return envelope;
}

export function encryptSecret(plaintext: string, source: VaultEnvSource = env): VaultEnvelope {
  const key = requireKey(source);
  const nonce = randomBytes(VAULT_NONCE_BYTES);
  const cipher = createCipheriv(VAULT_ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyVersion: CURRENT_KEY_VERSION,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function serialiseEnvelope(envelope: VaultEnvelope): string {
  const { keyVersion, nonce, ciphertext, tag } = normaliseEnvelope(envelope);
  return [ENVELOPE_PREFIX, `v${keyVersion}`, nonce, ciphertext, tag].join('.');
}

export function parseEnvelope(serialised: string): VaultEnvelope {
  const parts = serialised.split('.');
  if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX) {
    throw new IntegrationsVaultError('VAULT_MALFORMED_ENVELOPE');
  }
  const versionMatch = /^v(\d+)$/.exec(parts[1] ?? '');
  if (!versionMatch) {
    throw new IntegrationsVaultError('VAULT_MALFORMED_ENVELOPE');
  }
  const envelope: VaultEnvelope = {
    keyVersion: Number.parseInt(versionMatch[1] ?? '', 10),
    nonce: parts[2] ?? '',
    ciphertext: parts[3] ?? '',
    tag: parts[4] ?? '',
  };
  return normaliseEnvelope(envelope);
}

export function decryptSecret(
  envelope: VaultEnvelope | string,
  source: VaultEnvSource = env,
): string {
  const parsed =
    typeof envelope === 'string' ? parseEnvelope(envelope) : normaliseEnvelope(envelope);
  const key = requireKey(source);
  if (parsed.keyVersion !== CURRENT_KEY_VERSION) {
    throw new IntegrationsVaultError('VAULT_UNSUPPORTED_KEY_VERSION');
  }
  try {
    const decipher = createDecipheriv(
      VAULT_ALGORITHM,
      key,
      decodeSegment(parsed.nonce, VAULT_NONCE_BYTES),
    );
    decipher.setAuthTag(decodeSegment(parsed.tag, VAULT_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(decodeSegment(parsed.ciphertext, null)),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // GCM authentication failure (tampered ciphertext/tag/nonce, wrong key)
    // and every other crypto failure collapse to one static, safe error.
    throw new IntegrationsVaultError('VAULT_DECRYPT_FAILED');
  }
}

/* ── Redaction helpers ────────────────────────────────────────────────────── */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /(secret|password|passwd|token|api[-_]?key|authorization|credential|ciphertext|nonce|private[-_]?key)/i;

/**
 * Mask a NON-SECRET identifier for display (a provider account id, a
 * connection ref): at most its last 4 characters survive. Never call this on
 * a secret itself — secrets are not displayed at all (§4.3); API responses
 * expose `hasCredential: boolean` plus this mask of a non-secret id.
 */
export function maskIdentifier(identifier: string | null | undefined): string | null {
  if (identifier === null || identifier === undefined || identifier === '') return null;
  if (identifier.length <= 4) return '••••';
  return `••••${identifier.slice(-4)}`;
}

/** Remove every occurrence of each known secret from a string bound for logs. */
export function scrubText(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Deep-copy a value bound for logs/audit, redacting: (a) any value stored
 * under a credential-shaped key, wholesale; (b) any occurrence of a known
 * secret inside any string. The input is never mutated.
 */
export function redactForLog<T>(value: T, knownSecrets: readonly string[] = []): T {
  return redactValue(value, knownSecrets) as T;
}

function redactValue(value: unknown, knownSecrets: readonly string[]): unknown {
  if (typeof value === 'string') return scrubText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, knownSecrets),
      ]),
    );
  }
  return value;
}
