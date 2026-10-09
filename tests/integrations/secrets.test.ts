import { describe, expect, it } from 'vitest';
import { parseRuntimeEnv } from '@/env';
import {
  assertCanCreateConnection,
  canCreateConnection,
  connectionGate,
} from '@/lib/integrations/config';
import {
  CURRENT_KEY_VERSION,
  IntegrationsVaultError,
  decryptSecret,
  encryptSecret,
  isVaultConfigured,
  maskIdentifier,
  parseEnvelope,
  redactForLog,
  scrubText,
  serialiseEnvelope,
  type VaultEnvelope,
} from '@/lib/integrations/secrets';

/**
 * Vault contract suite (Phase 10 contract §4.3, Wave K). DB-free by design:
 * the vault is pure `node:crypto` over an env-supplied key, so every case
 * passes an explicit env source — nothing here opens a connection or reads
 * the ambient environment for its assertions.
 */

const KEY_A = Buffer.alloc(32, 0x11).toString('base64');
const KEY_B = Buffer.alloc(32, 0x77).toString('base64');
const SHORT_KEY = Buffer.alloc(16, 0x22).toString('base64');

const WITH_KEY = { INTEGRATIONS_ENCRYPTION_KEY: KEY_A };
const WITH_OTHER_KEY = { INTEGRATIONS_ENCRYPTION_KEY: KEY_B };
const UNSET: { INTEGRATIONS_ENCRYPTION_KEY?: string } = {};

const PLAINTEXT = 'sk-live-sentinel-credential-0123456789';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function expectVaultError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(IntegrationsVaultError);
  expect((error as IntegrationsVaultError).code).toBe(code);
  // Error hygiene (§4.3): static messages only — never the plaintext, never key material.
  expect((error as Error).message).not.toContain(PLAINTEXT);
  expect((error as Error).message).not.toContain(KEY_A);
}

/** Flip the first base64 character — same alphabet, same length, different bytes. */
function flip(segment: string): string {
  return (segment.startsWith('A') ? 'B' : 'A') + segment.slice(1);
}

describe('vault — encrypt/decrypt', () => {
  it('round-trips a credential through the envelope object form', () => {
    const envelope = encryptSecret(PLAINTEXT, WITH_KEY);
    expect(envelope.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(Buffer.from(envelope.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16);
    expect(decryptSecret(envelope, WITH_KEY)).toBe(PLAINTEXT);
  });

  it('round-trips unicode and empty plaintexts', () => {
    expect(decryptSecret(encryptSecret('pä55wörd—✓', WITH_KEY), WITH_KEY)).toBe('pä55wörd—✓');
    expect(decryptSecret(encryptSecret('', WITH_KEY), WITH_KEY)).toBe('');
  });

  it('uses a fresh nonce per encryption: same plaintext, different envelopes', () => {
    const first = encryptSecret(PLAINTEXT, WITH_KEY);
    const second = encryptSecret(PLAINTEXT, WITH_KEY);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(decryptSecret(second, WITH_KEY)).toBe(PLAINTEXT);
  });

  it('round-trips through the serialised string form', () => {
    const envelope = encryptSecret(PLAINTEXT, WITH_KEY);
    const serialised = serialiseEnvelope(envelope);
    expect(serialised.startsWith(`intg.v${CURRENT_KEY_VERSION}.`)).toBe(true);
    expect(parseEnvelope(serialised)).toEqual(envelope);
    expect(decryptSecret(serialised, WITH_KEY)).toBe(PLAINTEXT);
  });
});

describe('vault — tamper and wrong key', () => {
  const envelope: VaultEnvelope = encryptSecret(PLAINTEXT, WITH_KEY);

  it('rejects a tampered ciphertext', () => {
    const error = caught(() =>
      decryptSecret({ ...envelope, ciphertext: flip(envelope.ciphertext) }, WITH_KEY),
    );
    expectVaultError(error, 'VAULT_DECRYPT_FAILED');
  });

  it('rejects a tampered authentication tag', () => {
    const error = caught(() => decryptSecret({ ...envelope, tag: flip(envelope.tag) }, WITH_KEY));
    expectVaultError(error, 'VAULT_DECRYPT_FAILED');
  });

  it('rejects a tampered nonce', () => {
    const error = caught(() =>
      decryptSecret({ ...envelope, nonce: flip(envelope.nonce) }, WITH_KEY),
    );
    expectVaultError(error, 'VAULT_DECRYPT_FAILED');
  });

  it('rejects decryption under the wrong key', () => {
    const error = caught(() => decryptSecret(envelope, WITH_OTHER_KEY));
    expectVaultError(error, 'VAULT_DECRYPT_FAILED');
  });
});

describe('vault — not configured', () => {
  it('isVaultConfigured reflects key presence and validity', () => {
    expect(isVaultConfigured(WITH_KEY)).toBe(true);
    expect(isVaultConfigured(UNSET)).toBe(false);
    expect(isVaultConfigured({ INTEGRATIONS_ENCRYPTION_KEY: SHORT_KEY })).toBe(false);
    expect(isVaultConfigured({ INTEGRATIONS_ENCRYPTION_KEY: 'not-base64!!' })).toBe(false);
  });

  it('encrypt and decrypt throw the typed NOT_CONFIGURED error when the key is unset', () => {
    expectVaultError(
      caught(() => encryptSecret(PLAINTEXT, UNSET)),
      'VAULT_NOT_CONFIGURED',
    );
    const envelope = encryptSecret(PLAINTEXT, WITH_KEY);
    expectVaultError(
      caught(() => decryptSecret(envelope, UNSET)),
      'VAULT_NOT_CONFIGURED',
    );
  });

  it('an invalid-length key is NOT_CONFIGURED, not a crash', () => {
    const bad = { INTEGRATIONS_ENCRYPTION_KEY: SHORT_KEY };
    expectVaultError(
      caught(() => encryptSecret(PLAINTEXT, bad)),
      'VAULT_NOT_CONFIGURED',
    );
  });
});

describe('vault — envelope parsing', () => {
  it('rejects malformed serialised envelopes', () => {
    for (const bad of ['', 'garbage', 'intg.v1.only.two', 'v1.a.b.c.d', 'intg.vX.aaaa.bbbb.cccc']) {
      expectVaultError(
        caught(() => parseEnvelope(bad)),
        'VAULT_MALFORMED_ENVELOPE',
      );
    }
  });

  it('rejects segments that decode to the wrong sizes', () => {
    const parts = serialiseEnvelope(encryptSecret(PLAINTEXT, WITH_KEY)).split('.');
    const withSegment = (index: number, value: string): string =>
      parts.map((part, i) => (i === index ? value : part)).join('.');
    const shortNonce = withSegment(2, Buffer.alloc(9, 1).toString('base64'));
    expectVaultError(
      caught(() => parseEnvelope(shortNonce)),
      'VAULT_MALFORMED_ENVELOPE',
    );
    const badTag = withSegment(4, Buffer.alloc(8, 1).toString('base64'));
    expectVaultError(
      caught(() => decryptSecret(badTag, WITH_KEY)),
      'VAULT_MALFORMED_ENVELOPE',
    );
  });

  it('rejects an envelope of an unsupported key version at decrypt time', () => {
    const envelope = encryptSecret(PLAINTEXT, WITH_KEY);
    const future = serialiseEnvelope({ ...envelope, keyVersion: 99 });
    expect(parseEnvelope(future).keyVersion).toBe(99);
    expectVaultError(
      caught(() => decryptSecret(future, WITH_KEY)),
      'VAULT_UNSUPPORTED_KEY_VERSION',
    );
  });
});

describe('tier gating (config.ts)', () => {
  it('Tier E (env-referenced) is always creatable', () => {
    expect(canCreateConnection('env', UNSET)).toBe(true);
    expect(() => assertCanCreateConnection('env', UNSET)).not.toThrow();
    expect(connectionGate('env', UNSET)).toEqual({ allowed: true });
  });

  it('Tier V (vault) requires a configured vault', () => {
    expect(canCreateConnection('vault', WITH_KEY)).toBe(true);
    expect(canCreateConnection('vault', UNSET)).toBe(false);
    expectVaultError(
      caught(() => assertCanCreateConnection('vault', UNSET)),
      'VAULT_NOT_CONFIGURED',
    );
    const gate = connectionGate('vault', UNSET);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expectVaultError(gate.error, 'VAULT_NOT_CONFIGURED');
  });
});

describe('runtime env — INTEGRATIONS_ENCRYPTION_KEY', () => {
  const BASE_ENV = {
    DATABASE_URL: 'postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db',
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
  };

  it('absence is valid — boot is unaffected', () => {
    const parsed = parseRuntimeEnv({ ...BASE_ENV });
    expect(parsed.INTEGRATIONS_ENCRYPTION_KEY).toBeUndefined();
    expect(isVaultConfigured(parsed)).toBe(false);
  });

  it('a base64 32-byte key is accepted and configures the vault', () => {
    const parsed = parseRuntimeEnv({ ...BASE_ENV, INTEGRATIONS_ENCRYPTION_KEY: KEY_A });
    expect(parsed.INTEGRATIONS_ENCRYPTION_KEY).toBe(KEY_A);
    expect(isVaultConfigured(parsed)).toBe(true);
    expect(decryptSecret(encryptSecret(PLAINTEXT, parsed), parsed)).toBe(PLAINTEXT);
  });

  it('a key that does not decode to 32 bytes fails env validation', () => {
    expect(() => parseRuntimeEnv({ ...BASE_ENV, INTEGRATIONS_ENCRYPTION_KEY: SHORT_KEY })).toThrow(
      /INTEGRATIONS_ENCRYPTION_KEY/,
    );
    expect(() =>
      parseRuntimeEnv({ ...BASE_ENV, INTEGRATIONS_ENCRYPTION_KEY: 'not-base64!!' }),
    ).toThrow(/INTEGRATIONS_ENCRYPTION_KEY/);
  });
});

describe('redaction helpers', () => {
  it('maskIdentifier exposes at most the last 4 of a non-secret id', () => {
    expect(maskIdentifier('conn_123456789')).toBe('••••6789');
    expect(maskIdentifier('abcd')).toBe('••••');
    expect(maskIdentifier('ab')).toBe('••••');
    expect(maskIdentifier(null)).toBeNull();
    expect(maskIdentifier(undefined)).toBeNull();
    expect(maskIdentifier('')).toBeNull();
  });

  it('scrubText removes every occurrence of a known secret', () => {
    const line = `provider said no for ${PLAINTEXT} and again ${PLAINTEXT}`;
    const scrubbed = scrubText(line, [PLAINTEXT]);
    expect(scrubbed).not.toContain(PLAINTEXT);
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('redactForLog redacts credential-shaped keys and known secrets, without mutating the input', () => {
    const input = {
      provider: 'resend',
      apiKey: 'whatever-value',
      nested: { note: `used ${PLAINTEXT} here`, signing_secret_ciphertext: 'AAAA' },
      list: [PLAINTEXT, 'plain'],
      count: 3,
    };
    const redacted = redactForLog(input, [PLAINTEXT]);
    const asText = JSON.stringify(redacted);
    expect(asText).not.toContain(PLAINTEXT);
    expect(asText).not.toContain('whatever-value');
    expect(redacted.provider).toBe('resend');
    expect(redacted.count).toBe(3);
    expect(redacted.list[1]).toBe('plain');
    // Input untouched.
    expect(input.apiKey).toBe('whatever-value');
    expect(input.nested.note).toContain(PLAINTEXT);
  });
});
